import { LLMProvider } from './LLMProvider.js';

// オークションデモ用のモックプロバイダー。
// 「〇〇に△△円で入札して」のようなパターンを判定するだけの決定的なロジック。
// bidプロパティは { amount, bidder, at } という1つのオブジェクトとして
// update-propertyで丸ごと上書きする(=LWW)。金額の大小チェックは一切行わない
// (これはバグではなく、このデモが意図的に見せている「素朴なLWWは競り上げの
// 検証をしない」という性質そのもの)。
function findItemByFuzzyName(snapshot, text) {
  const items = snapshot.filter((n) => n.properties?.type === 'item');
  return items.find((it) => it.properties?.name && text.includes(it.properties.name)) || null;
}

function extractAmount(text) {
  const match = text.match(/([0-9０-９,，]+)\s*円/);
  if (!match) return null;
  const normalized = match[1].replace(/[０-９]/g, (d) => '0123456789'['０１２３４５６７８９'.indexOf(d)]).replace(/[,，]/g, '');
  const n = parseInt(normalized, 10);
  return Number.isNaN(n) ? null : n;
}

export class AuctionMockLLMProvider extends LLMProvider {
  async proposeActions({ instruction, snapshot }) {
    const text = String(instruction || '').trim();
    if (!text) return { actions: [] };

    const items = snapshot.filter((n) => n.properties?.type === 'item');
    if (items.length === 0) return { actions: [] };

    const item = findItemByFuzzyName(snapshot, text) || items[0];
    const explicitAmount = extractAmount(text);
    const currentBid = item.properties?.bid?.amount ?? item.properties?.startBid ?? 0;

    // 明示的な金額指定が無ければ、現在の最高額に少し上乗せした「妥当そうな」額で入札する
    // (AIの提案が見た目は自然に見えても、サーバー側は金額の大小を一切検証していない、
    //  という対比を見せるのが狙い)
    const amount = explicitAmount ?? currentBid + Math.round((100 + Math.random() * 400) / 100) * 100;

    return {
      actions: [
        {
          type: 'update-property',
          nodeId: item.id,
          key: 'bid',
          value: { amount, bidder: 'ai-agent', at: Date.now() },
        },
      ],
    };
  }
}
