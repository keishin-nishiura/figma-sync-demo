import { randomUUID } from 'node:crypto';

export const AI_CLIENT_ID = 'ai-agent';

// 少数(Kanbanのタスク数件など)のアクションは、カーソル移動→選択→適用→
// 選択解除、という「演出込み」のペースで1件ずつ見せる。
// ピクセルキャンバスを塗りつぶすような大量アクションでこの演出をそのまま
// 使うと、100件を演出しながら実行するのに1分近くかかってしまい、逆に
// 「AIが何をしているか分かりにくい」体験になってしまう。そこで件数が
// 閾値を超えた場合は、カーソル演出を省略した高速ペースに切り替える。
// (=見せ方の最適なペースは「操作の粒度」によって変わる、という判断)
const CINEMATIC_STEP_DELAY_MIN_MS = 300;
const CINEMATIC_STEP_DELAY_MAX_MS = 700;
const FAST_BATCH_THRESHOLD = 8;
const FAST_STEP_DELAY_MS = 30;
const MAX_ACTIONS_PER_INSTRUCTION = 250;

function randDelay() {
  return CINEMATIC_STEP_DELAY_MIN_MS + Math.random() * (CINEMATIC_STEP_DELAY_MAX_MS - CINEMATIC_STEP_DELAY_MIN_MS);
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
    case 'create-node': {
      const props = result.payload.node.properties || {};
      if (props.type === 'column') return `新しい列「${props.name ?? result.payload.node.id}」を作成しました`;
      return `新しいタスク「${props.title ?? result.payload.node.id}」を作成しました`;
    }
    case 'update-property':
      if (action.key === 'priority') return `${action.nodeId} を優先(⭐)にマークしました`;
      if (action.key === 'title') return `${action.nodeId} の名前を「${action.value}」に変更しました`;
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
    actions = Array.isArray(result?.actions) ? result.actions.slice(0, MAX_ACTIONS_PER_INSTRUCTION) : [];
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

  const isFastBatch = actions.length > FAST_BATCH_THRESHOLD;
  if (isFastBatch) {
    logActivity(room, {
      actor: AI_CLIENT_ID,
      action: 'ai-fast-batch',
      detail: `${actions.length}件を一括処理します(演出を省略して高速に適用します)`,
    });
  }

  let rejectedCount = 0;
  for (const action of actions) {
    const targetNodeId = action.nodeId ?? null;
    const showCinematic = !isFastBatch && targetNodeId && room.doc.nodes.has(targetNodeId);

    if (showCinematic) {
      broadcast(room, { type: 'ai-cursor', nodeId: targetNodeId });
      await sleep(randDelay());
      broadcast(room, { type: 'select-node', nodeId: targetNodeId, fromClientId: AI_CLIENT_ID });
      await sleep(200);
    }

    const result = validateAndApply(room.doc, action);
    const opId = `ai-${randomUUID().slice(0, 8)}`;

    if (result.ok) {
      broadcast(room, { type: result.broadcastType, ...result.payload, opId, fromClientId: AI_CLIENT_ID });
      // 高速バッチ中は1件ごとのログでフィードを埋め尽くさないよう、要約のみ後でまとめて出す
      if (!isFastBatch) {
        logActivity(room, { actor: AI_CLIENT_ID, action: action.type, detail: describeAction(action, result) });
      }
    } else {
      rejectedCount += 1;
      if (!isFastBatch) {
        logActivity(room, {
          actor: AI_CLIENT_ID,
          action: `${action.type || 'unknown'}-rejected`,
          detail: `拒否: ${result.reason}`,
        });
      }
    }

    if (showCinematic) {
      await sleep(300);
      broadcast(room, { type: 'deselect-node', fromClientId: AI_CLIENT_ID });
    }
    await sleep(isFastBatch ? FAST_STEP_DELAY_MS : randDelay());
  }

  if (isFastBatch) {
    const appliedCount = actions.length - rejectedCount;
    logActivity(room, {
      actor: AI_CLIENT_ID,
      action: 'ai-fast-batch-done',
      detail: `一括処理が完了しました(適用 ${appliedCount}件 / 拒否 ${rejectedCount}件)`,
    });
  }

  room.aiStatus = 'idle';
  broadcast(room, { type: 'ai-status', status: 'idle' });
}
