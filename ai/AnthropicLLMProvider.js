import { LLMProvider } from './LLMProvider.js';

// AI_MODE=live かつ ANTHROPIC_API_KEY が設定されている場合にのみ読み込まれる
// 実LLM版のプロバイダー。Node標準のfetchのみを使い、追加の依存関係を増やさない。
// APIキーはサーバー側の環境変数からしか読まず、ブラウザに渡ることは無い。
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';

const SYSTEM_PROMPT = `あなたはKanbanボード(Group/Column配下にTaskを持つツリー構造)を操作するAIエージェントです。
ユーザーの自然言語の指示と、現在のボードのスナップショット(JSON)を受け取り、
実行すべきアクションの配列だけを、次のJSON形式で出力してください。他の文章は一切出力しないこと。

{"actions": [
  {"type": "create-node", "parentId": "<列のid>", "properties": {"type": "task", "title": "<タイトル>"}},
  {"type": "update-property", "nodeId": "<id>", "key": "title", "value": "<新しい値>"},
  {"type": "reparent", "nodeId": "<タスクid>", "newParentId": "<移動先の列id>"},
  {"type": "delete-node", "nodeId": "<id>"}
]}

- 存在しないidを作らないこと(create-node以外は必ずスナップショットに存在するidを使う)。
- アクションは多くても5件程度に収める。
- 指示が曖昧な場合は、最も自然だと思われる1件のアクションだけを返す。`;

export class AnthropicLLMProvider extends LLMProvider {
  async proposeActions({ instruction, snapshot }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `現在のボード状態:\n${JSON.stringify(snapshot)}\n\n指示: ${instruction}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const text = data?.content?.find((c) => c.type === 'text')?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { actions: [] };
    return { actions: Array.isArray(parsed.actions) ? parsed.actions : [] };
  }
}
