import { LLMProvider } from './LLMProvider.js';

// AI_MODE=mock (デフォルト) で使われる、決定的なルールベース実装。
// 外部APIを一切呼ばないため、APIキー無しで公開デモを動かせる。
// 自然言語を「理解」しているわけではなく、単純なキーワード一致で
// アクションを組み立てているだけだが、それでも
// 「自然言語の指示 → 構造化されたアクション → 検証 → 適用」という
// パイプライン全体と、AIが実行できる操作の幅広さを確認できることが目的。
//
// 対応している指示の種類(上から順にマッチを試す。特殊なものから先に判定する):
//   1. 列を空にする/全削除          例:「Doneを空にして」
//   2. 特定のタスクを削除           例:「レビュー依頼を削除して」
//   3. 全タスクを一括で完了に       例:「全部完了にして」
//   4. 列内のタスクを並び替え       例:「To Doを並び替えて」(五十音順)
//   5. タスクを優先(⭐)にする       例:「デモを実装するを優先にして」
//   6. 新しい列を追加               例:「レビュー列を追加して」
//   7. タスク名を変更               例:「AをBに変更して」
//   8. 完了/進行中への移動          例:「〇〇を完了にして」「〇〇を進行中に」
//   9. 複数タスクを一括追加         例:「タスクを追加して: レビュー、テスト、リリース」
//  10. 単一タスクの追加             例:「「レビュー依頼」を追加して」
//  11. フォールバック               何にも一致しない自由入力は、そのままTo Doへ新規タスクとして追加

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

function findAnyColumnByName(snapshot, text) {
  const columns = snapshot.filter((n) => n.properties?.type === 'column');
  return columns.find((c) => c.properties?.name && text.includes(c.properties.name)) || null;
}

function findTaskByFuzzyTitle(snapshot, text) {
  const tasks = snapshot.filter((n) => n.properties?.type === 'task');
  return tasks.find((t) => t.properties?.title && text.includes(t.properties.title)) || null;
}

function tasksInColumn(snapshot, columnId) {
  return snapshot.filter((n) => n.properties?.type === 'task' && n.parentId === columnId);
}

// 指定した順序でmove-nodeを積み重ねることで並び替えを実現する。
// 「先頭から順に、直前に置いたノードの直後(末尾)へ追加していく」だけで、
// Fractional Indexingの性質上、常に意図した最終順序に収束する。
function buildReorderActions(orderedIds) {
  const actions = [];
  let beforeId = null;
  for (const id of orderedIds) {
    actions.push({ type: 'move-node', nodeId: id, beforeId, afterId: null });
    beforeId = id;
  }
  return actions;
}

export class MockLLMProvider extends LLMProvider {
  async proposeActions({ instruction, snapshot }) {
    const text = String(instruction || '').trim();
    const lower = text.toLowerCase();
    if (!text) return { actions: [] };

    const doneCol = findColumnByAlias(snapshot, 'done');
    const doingCol = findColumnByAlias(snapshot, 'doing');
    const todoCol = findColumnByAlias(snapshot, 'todo');
    const anyCol = snapshot.find((n) => n.properties?.type === 'column');

    // 1. 列を空にする
    if (/空に|全部削除|すべて削除|clear/.test(lower) || /空に|全部削除|すべて削除/.test(text)) {
      const col = findAnyColumnByName(snapshot, text) || doneCol;
      if (col) {
        const tasks = tasksInColumn(snapshot, col.id);
        if (tasks.length > 0) {
          return { actions: tasks.map((t) => ({ type: 'delete-node', nodeId: t.id })) };
        }
      }
    }

    // 2. 特定タスクの削除
    if (/削除|消して|remove|delete/.test(lower) || /削除|消して/.test(text)) {
      const task = findTaskByFuzzyTitle(snapshot, text);
      if (task) return { actions: [{ type: 'delete-node', nodeId: task.id }] };
    }

    // 3. 全タスク一括完了
    if (/全部|すべて|全て/.test(text) && (/完了|終わ|done/.test(lower))) {
      if (doneCol) {
        const tasks = snapshot.filter((n) => n.properties?.type === 'task' && n.parentId !== doneCol.id);
        if (tasks.length > 0) {
          return { actions: tasks.map((t) => ({ type: 'reparent', nodeId: t.id, newParentId: doneCol.id })) };
        }
      }
    }

    // 4. 列内の並び替え(五十音/アルファベット順)
    if (/並び替え|並べ替え|ソート|sort|整理/.test(lower) || /並び替え|並べ替え|整理/.test(text)) {
      const col = findAnyColumnByName(snapshot, text) || todoCol || anyCol;
      if (col) {
        const tasks = tasksInColumn(snapshot, col.id);
        if (tasks.length > 1) {
          const ordered = [...tasks].sort((a, b) =>
            (a.properties.title || '').localeCompare(b.properties.title || '', 'ja')
          );
          return { actions: buildReorderActions(ordered.map((t) => t.id)) };
        }
      }
    }

    // 5. 優先マーク
    if (/優先|urgent|緊急|priority/.test(lower) || /優先|緊急/.test(text)) {
      const task = findTaskByFuzzyTitle(snapshot, text);
      if (task) {
        return { actions: [{ type: 'update-property', nodeId: task.id, key: 'priority', value: 'high' }] };
      }
    }

    // 6. 新しい列を追加
    if (/列を追加|カラムを追加|add.*column|新しい列/.test(lower) || /列を追加|カラムを追加|新しい列/.test(text)) {
      const quoted = text.match(/(?:「(.+?)」|"(.+?)")/);
      const name = (quoted && (quoted[1] || quoted[2])) ||
        text.replace(/列を追加して?|カラムを追加して?|新しい列|add.*column/gi, '').trim() ||
        '新しい列';
      const palette = ['#64748b', '#eab308', '#22c55e', '#a855f7', '#ec4899', '#3b82f6'];
      const color = palette[Math.floor(Math.random() * palette.length)];
      const columnId = `col-${Math.random().toString(36).slice(2, 8)}`;
      return {
        actions: [{ type: 'create-node', nodeId: columnId, parentId: 'root', properties: { type: 'column', name: name.slice(0, 30), color } }],
      };
    }

    // 7. タスク名の変更「AをBに変更して」
    const renameMatch = text.match(/(.+)を(.+?)に(?:変更|リネーム|名前変更)/);
    if (renameMatch) {
      const task = findTaskByFuzzyTitle(snapshot, renameMatch[1]) || findTaskByFuzzyTitle(snapshot, text);
      if (task) {
        return { actions: [{ type: 'update-property', nodeId: task.id, key: 'title', value: renameMatch[2].trim().slice(0, 60) }] };
      }
    }

    // 8. 完了/進行中への移動
    if (/完了|終わ|done|finish/.test(lower)) {
      const task = findTaskByFuzzyTitle(snapshot, text);
      if (task && doneCol) return { actions: [{ type: 'reparent', nodeId: task.id, newParentId: doneCol.id }] };
    }
    if (/進行中|着手|doing|in progress/.test(lower) || /進行中|着手/.test(text)) {
      const task = findTaskByFuzzyTitle(snapshot, text);
      if (task && doingCol) return { actions: [{ type: 'reparent', nodeId: task.id, newParentId: doingCol.id }] };
    }

    // 9 & 10. タスクの追加(複数 or 単一)
    const wantsAdd = /追加|作成|add task|create task/.test(lower) || /追加|作成/.test(text);
    const quoted = text.match(/(?:「(.+?)」|"(.+?)")/);
    if (wantsAdd || quoted) {
      const rawTail = text.replace(/.*(?:タスクを追加して?|追加して?|作成して?|add tasks?|create tasks?)[:：]?/i, '').trim();
      const listSeparatorPattern = /[、,]/;
      if (!quoted && listSeparatorPattern.test(rawTail) && rawTail.split(listSeparatorPattern).length > 1) {
        const titles = rawTail
          .split(listSeparatorPattern)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 6);
        const targetCol = todoCol || anyCol;
        if (targetCol && titles.length > 1) {
          return {
            actions: titles.map((title) => ({
              type: 'create-node',
              parentId: targetCol.id,
              properties: { type: 'task', title: title.slice(0, 60) },
            })),
          };
        }
      }

      const title = (quoted && (quoted[1] || quoted[2])) || rawTail || text;
      const targetCol = todoCol || anyCol;
      if (targetCol) {
        return {
          actions: [{ type: 'create-node', parentId: targetCol.id, properties: { type: 'task', title: title.slice(0, 60) } }],
        };
      }
    }

    // 11. フォールバック: 何にも当てはまらない自由入力は、指示文そのものを
    // 新しいタスクとしてTo Do相当の列に追加する(モックでも必ず何か目に見える変化を起こす)
    const fallbackCol = todoCol || anyCol;
    if (fallbackCol) {
      return { actions: [{ type: 'create-node', parentId: fallbackCol.id, properties: { type: 'task', title: `📝 ${text}`.slice(0, 60) } }] };
    }
    return { actions: [] };
  }
}
