import { LLMProvider } from './LLMProvider.js';

// AI_MODE=mock (デフォルト) で使われる、決定的なルールベース実装。
// 外部APIを一切呼ばないため、APIキー無しで公開デモを動かせる。
// 自然言語を「理解」しているわけではなく、単純なキーワード一致で
// アクションを組み立てているだけだが、それでも
// 「自然言語の指示 → 構造化されたアクション → 検証 → 適用」という
// パイプライン全体を確認できることが目的。

const COLUMN_ALIASES = {
  todo: ['todo', 'to do', '未着手', 'やること'],
  doing: ['doing', 'in progress', '進行中', '着手'],
  done: ['done', '完了', '終わ'],
};

function findColumnByAlias(snapshot, aliasKey) {
  const aliases = COLUMN_ALIASES[aliasKey];
  return snapshot.find(
    (n) =>
      n.properties?.type === 'column' &&
      aliases.some((a) => (n.properties.name || '').toLowerCase().includes(a))
  );
}

function findTaskByFuzzyTitle(snapshot, text) {
  const tasks = snapshot.filter((n) => n.properties?.type === 'task');
  return tasks.find((t) => t.properties?.title && text.includes(t.properties.title)) || null;
}

export class MockLLMProvider extends LLMProvider {
  async proposeActions({ instruction, snapshot }) {
    const text = String(instruction || '').trim();
    const lower = text.toLowerCase();
    const actions = [];

    const doneCol = findColumnByAlias(snapshot, 'done');
    const doingCol = findColumnByAlias(snapshot, 'doing');
    const todoCol = findColumnByAlias(snapshot, 'todo');
    const anyCol = snapshot.find((n) => n.properties?.type === 'column');

    // 削除指示
    if (/削除|消して|remove|delete/.test(lower) || /削除|消して/.test(text)) {
      const task = findTaskByFuzzyTitle(snapshot, text);
      if (task) {
        actions.push({ type: 'delete-node', nodeId: task.id });
        return { actions };
      }
    }

    // 完了指示
    if (/完了|終わ|done|finish/.test(lower)) {
      const task = findTaskByFuzzyTitle(snapshot, text);
      if (task && doneCol) {
        actions.push({ type: 'reparent', nodeId: task.id, newParentId: doneCol.id });
        return { actions };
      }
    }

    // 着手指示
    if (/進行中|着手|start doing|in progress/.test(lower) || /進行中|着手/.test(text)) {
      const task = findTaskByFuzzyTitle(snapshot, text);
      if (task && doingCol) {
        actions.push({ type: 'reparent', nodeId: task.id, newParentId: doingCol.id });
        return { actions };
      }
    }

    // 追加指示(「」やダブルクォートでタイトルを指定できる)
    const quoted = text.match(/(?:「(.+?)」|"(.+?)")/);
    const wantsAdd = /追加|作成|add task|create task/.test(lower) || /追加|作成/.test(text);
    if (wantsAdd || quoted) {
      const rawTitle =
        (quoted && (quoted[1] || quoted[2])) ||
        text.replace(/タスクを|を追加して?|追加して?|作成して?|add task|create task/gi, '').trim();
      const title = (rawTitle || text).slice(0, 60);
      const targetCol = todoCol || anyCol;
      if (targetCol) {
        actions.push({
          type: 'create-node',
          parentId: targetCol.id,
          properties: { type: 'task', title },
        });
        return { actions };
      }
    }

    // フォールバック: どのパターンにも当てはまらない自由入力は、
    // 指示文そのものを新しいタスクとしてTo Do相当の列に追加する。
    // (モックであっても必ず目に見える変化を起こすための決定的な挙動)
    const fallbackCol = todoCol || anyCol;
    if (fallbackCol && text) {
      actions.push({
        type: 'create-node',
        parentId: fallbackCol.id,
        properties: { type: 'task', title: `📝 ${text}`.slice(0, 60) },
      });
    }
    return { actions };
  }
}
