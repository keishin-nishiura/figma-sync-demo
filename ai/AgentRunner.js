import { randomUUID } from 'node:crypto';

export const AI_CLIENT_ID = 'ai-agent';

const STEP_DELAY_MIN_MS = 300;
const STEP_DELAY_MAX_MS = 700;

function randDelay() {
  return STEP_DELAY_MIN_MS + Math.random() * (STEP_DELAY_MAX_MS - STEP_DELAY_MIN_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// AIが提案した1件のアクションを検証し、既存のDocument操作関数を通して適用する。
// これは server/index.js の人間側メッセージハンドラが行っている検証と同じもの
// (存在チェック・reparentの循環参照拒否など)を、AI用にもう一度素通しさせている
// だけであり、AI専用の抜け道でdoc.nodesを直接いじる処理はどこにも無い。
function validateAndApply(doc, action) {
  if (!action || typeof action.type !== 'string') {
    return { ok: false, reason: '不正なアクション形式です' };
  }

  switch (action.type) {
    case 'create-node': {
      if (!action.parentId || !doc.nodes.has(action.parentId)) {
        return { ok: false, reason: '親ノードが存在しません' };
      }
      const nodeId = action.nodeId || `ai-${randomUUID().slice(0, 8)}`;
      if (doc.nodes.has(nodeId)) {
        return { ok: false, reason: 'nodeIdが重複しています' };
      }
      const node = doc.createNode(nodeId, action.parentId, action.properties || {});
      return { ok: true, broadcastType: 'node-created', payload: { node } };
    }
    case 'update-property': {
      if (!action.nodeId || !doc.nodes.has(action.nodeId)) {
        return { ok: false, reason: '対象ノードが存在しません' };
      }
      const node = doc.applyPropertyUpdate(action.nodeId, action.key, action.value);
      if (!node) return { ok: false, reason: '更新に失敗しました' };
      return {
        ok: true,
        broadcastType: 'property-updated',
        payload: { nodeId: action.nodeId, key: action.key, value: action.value },
      };
    }
    case 'reparent': {
      if (!action.nodeId || !doc.nodes.has(action.nodeId) || !doc.nodes.has(action.newParentId)) {
        return { ok: false, reason: 'ノードが存在しません' };
      }
      const node = doc.reparent(action.nodeId, action.newParentId);
      if (!node) return { ok: false, reason: '循環参照になるため拒否されました' };
      return {
        ok: true,
        broadcastType: 'reparent-applied',
        payload: { nodeId: action.nodeId, newParentId: action.newParentId, order: node.order },
      };
    }
    case 'move-node': {
      if (!action.nodeId || !doc.nodes.has(action.nodeId)) {
        return { ok: false, reason: '対象ノードが存在しません' };
      }
      const node = doc.moveNode(action.nodeId, action.beforeId ?? null, action.afterId ?? null);
      if (!node) return { ok: false, reason: '並び替えに失敗しました' };
      return { ok: true, broadcastType: 'node-moved', payload: { nodeId: action.nodeId, order: node.order } };
    }
    case 'delete-node': {
      if (!action.nodeId || !doc.nodes.has(action.nodeId)) {
        return { ok: false, reason: '対象ノードが存在しません' };
      }
      doc.deleteNode(action.nodeId);
      return { ok: true, broadcastType: 'node-deleted', payload: { nodeId: action.nodeId } };
    }
    default:
      return { ok: false, reason: `未対応のアクション種別: ${action.type}` };
  }
}

function describeAction(action, result) {
  switch (action.type) {
    case 'create-node':
      return `新しいタスク「${result.payload.node.properties?.title ?? result.payload.node.id}」を作成しました`;
    case 'update-property':
      return `${action.nodeId} の ${action.key} を更新しました`;
    case 'reparent':
      return `${action.nodeId} を別の列に移動しました`;
    case 'move-node':
      return `${action.nodeId} を並び替えました`;
    case 'delete-node':
      return `${action.nodeId} を削除しました`;
    default:
      return JSON.stringify(action);
  }
}

// 1つの自然言語指示を処理する。
// 人間の操作と全く同じ「Document変更 → broadcast」経路を1アクションずつ、
// 見た目にも分かるペース(300〜700ms)で実行する。UIをブロックしないよう、
// server/index.js側ではこの関数をawaitせずに呼び出す(fire-and-forget)。
export async function runAgentInstruction({ room, instruction, provider, broadcast, logActivity }) {
  if (room.aiStatus !== 'idle') {
    logActivity(room, {
      actor: AI_CLIENT_ID,
      action: 'ai-busy',
      detail: 'AIは他の指示を処理中のため、今回の指示はスキップされました',
    });
    return;
  }

  room.aiStatus = 'thinking';
  broadcast(room, { type: 'ai-status', status: 'thinking' });
  logActivity(room, { actor: AI_CLIENT_ID, action: 'ai-thinking', detail: `指示を検討中: 「${instruction}」` });
  await sleep(400);

  let actions = [];
  try {
    const snapshot = room.doc.toJSON();
    const result = await provider.proposeActions({ instruction, snapshot });
    actions = Array.isArray(result?.actions) ? result.actions.slice(0, 8) : [];
  } catch (err) {
    console.error('[ai] proposeActions failed:', err);
    logActivity(room, { actor: AI_CLIENT_ID, action: 'ai-error', detail: 'アクションの生成に失敗しました' });
    room.aiStatus = 'idle';
    broadcast(room, { type: 'ai-status', status: 'idle' });
    return;
  }

  if (actions.length === 0) {
    logActivity(room, { actor: AI_CLIENT_ID, action: 'ai-noop', detail: '実行可能なアクションが見つかりませんでした' });
  }

  room.aiStatus = 'acting';
  broadcast(room, { type: 'ai-status', status: 'acting' });

  for (const action of actions) {
    const targetNodeId = action.nodeId ?? null;

    if (targetNodeId && room.doc.nodes.has(targetNodeId)) {
      broadcast(room, { type: 'ai-cursor', nodeId: targetNodeId });
      await sleep(randDelay());
      broadcast(room, { type: 'select-node', nodeId: targetNodeId, fromClientId: AI_CLIENT_ID });
      await sleep(200);
    }

    const result = validateAndApply(room.doc, action);
    const opId = `ai-${randomUUID().slice(0, 8)}`;

    if (result.ok) {
      broadcast(room, { type: result.broadcastType, ...result.payload, opId, fromClientId: AI_CLIENT_ID });
      logActivity(room, { actor: AI_CLIENT_ID, action: action.type, detail: describeAction(action, result) });
    } else {
      logActivity(room, {
        actor: AI_CLIENT_ID,
        action: `${action.type || 'unknown'}-rejected`,
        detail: `拒否: ${result.reason}`,
      });
    }

    if (targetNodeId && room.doc.nodes.has(targetNodeId)) {
      await sleep(300);
      broadcast(room, { type: 'deselect-node', fromClientId: AI_CLIENT_ID });
    }
    await sleep(randDelay());
  }

  room.aiStatus = 'idle';
  broadcast(room, { type: 'ai-status', status: 'idle' });
}
