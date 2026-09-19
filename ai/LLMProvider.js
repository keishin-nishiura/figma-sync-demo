// LLMプロバイダーの共通インターフェース。
//
// 実装が担う責務は「現在のワークスペース状態 + 自然言語の指示」を受け取り、
// { actions: [...] } という構造化されたアクション列を返すことだけ。
// ここで返されたアクションがDocumentを直接書き換えることは絶対になく、
// 必ず ai/AgentRunner.js 側のバリデーション + server/document.js の
// 既存の操作関数(applyPropertyUpdate/reparent/moveNode/createNode/deleteNode)
// を経由する。LLM(あるいはモック)の出力は「信頼できない入力」として扱う。
export class LLMProvider {
  // eslint-disable-next-line no-unused-vars
  async proposeActions({ instruction, snapshot }) {
    throw new Error('proposeActions must be implemented by a subclass');
  }
}

// 環境変数からプロバイダーを選択する。
// - AI_MODE=mock (デフォルト): APIキー不要。ルールベースの決定的な動作。
// - AI_MODE=live かつ ANTHROPIC_API_KEY が設定されている: 実際のLLMを呼び出す。
// - AI_MODE=live だが ANTHROPIC_API_KEY が無い場合: モックにフォールバックする。
export async function createLLMProvider() {
  const { MockLLMProvider } = await import('./MockLLMProvider.js');
  const mode = (process.env.AI_MODE || 'mock').toLowerCase();

  if (mode === 'live' && process.env.ANTHROPIC_API_KEY) {
    try {
      const { AnthropicLLMProvider } = await import('./AnthropicLLMProvider.js');
      console.log('[ai] AI_MODE=live: Anthropic APIを使用します');
      return new AnthropicLLMProvider();
    } catch (err) {
      console.error('[ai] AnthropicLLMProviderの初期化に失敗したため、モックにフォールバックします:', err.message);
      return new MockLLMProvider();
    }
  }

  if (mode === 'live') {
    console.log('[ai] AI_MODE=live が指定されましたが ANTHROPIC_API_KEY が未設定のため、モックプロバイダーにフォールバックします');
  } else {
    console.log('[ai] AI_MODE=mock (デフォルト。APIキー不要で動作します)');
  }
  return new MockLLMProvider();
}
