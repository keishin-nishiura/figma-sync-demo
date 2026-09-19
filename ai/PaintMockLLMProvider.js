import { LLMProvider } from './LLMProvider.js';

// ピクセルキャンバスデモ用のモックプロバイダー。
// 「左上を青で塗って」のような指示から、対象領域(グリッド上の矩形)と色を
// 決定論的に判定し、その範囲内の全セルに対する update-property を
// まとめて返す。セル数が多い指示は ai/AgentRunner.js 側の
// 「高速バッチモード」で、演出を省いて素早く適用される。

const COLOR_NAMES = {
  赤: '#ef4444', red: '#ef4444',
  青: '#3b82f6', blue: '#3b82f6',
  緑: '#22c55e', green: '#22c55e',
  黄色: '#eab308', 黄: '#eab308', yellow: '#eab308',
  紫: '#a855f7', purple: '#a855f7',
  ピンク: '#ec4899', pink: '#ec4899',
  オレンジ: '#f97316', orange: '#f97316',
  白: '#ffffff', white: '#ffffff',
  黒: '#1e1e1e', black: '#1e1e1e',
  グレー: '#94a3b8', 灰色: '#94a3b8', gray: '#94a3b8', grey: '#94a3b8',
  水色: '#38bdf8', 茶色: '#92400e', 茶: '#92400e',
};

function pickColor(text) {
  const lower = text.toLowerCase();
  for (const [name, hex] of Object.entries(COLOR_NAMES)) {
    if (text.includes(name) || lower.includes(name.toLowerCase())) return hex;
  }
  return null;
}

// 指定領域からセルを絞り込む。gridSizeはスナップショットから動的に求める。
function pickRegion(text, cells, gridSize) {
  const half = gridSize / 2;
  const isTop = /上/.test(text) && !/以上/.test(text);
  const isBottom = /下/.test(text);
  const isLeft = /左/.test(text);
  const isRight = /右/.test(text);
  const isCenter = /真ん中|中央|center/i.test(text);
  const isAll = /全部|すべて|全て|all/i.test(text);

  if (isAll) return cells;

  if (isCenter) {
    const c0 = Math.floor(gridSize / 3);
    const c1 = Math.ceil((gridSize * 2) / 3);
    return cells.filter((c) => c.properties.row >= c0 && c.properties.row < c1 && c.properties.col >= c0 && c.properties.col < c1);
  }

  if (!isTop && !isBottom && !isLeft && !isRight) return null; // 領域指定なし

  return cells.filter((c) => {
    const rowOk = isTop ? c.properties.row < half : isBottom ? c.properties.row >= half : true;
    const colOk = isLeft ? c.properties.col < half : isRight ? c.properties.col >= half : true;
    return rowOk && colOk;
  });
}

export class PaintMockLLMProvider extends LLMProvider {
  async proposeActions({ instruction, snapshot }) {
    const text = String(instruction || '').trim();
    if (!text) return { actions: [] };

    const cells = snapshot.filter((n) => n.properties?.type === 'cell');
    if (cells.length === 0) return { actions: [] };

    const gridSize = Math.max(...cells.map((c) => c.properties.row)) + 1;
    const color = pickColor(text) || '#3b82f6';
    let region = pickRegion(text, cells, gridSize);

    if (!region) {
      // 領域が特定できない自由な指示は、中央付近を軽く塗って
      // 「何かが起きたこと」を必ず見せる(モックのフォールバック方針を踏襲)
      const mid = Math.floor(gridSize / 2);
      region = cells.filter((c) => Math.abs(c.properties.row - mid) <= 1 && Math.abs(c.properties.col - mid) <= 1);
    }

    return {
      actions: region.map((cell) => ({
        type: 'update-property',
        nodeId: cell.id,
        key: 'color',
        value: color,
      })),
    };
  }
}
