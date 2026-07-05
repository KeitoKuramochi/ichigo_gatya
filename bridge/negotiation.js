// AI店番エージェントとの値切り交渉を1ターン進める。
//
// 価格はモデルの自由な返答文から抜き出さず、tool-forcing(強制の関数呼び出し)で
// 構造化出力(quoteツール)を強制して受け取る。受け取った価格・品質評価が実際に
// フロア以上か等の妥当性検証・確定は呼び出し側(server.js)の責務(このモジュールは
// LLM APIを叩くだけ)。
//
// メインはAnthropic(Claude)。Anthropic側が障害・タイムアウト等で応答できなかった
// 場合だけ、設定されていればGoogle Geminiにフォールバックする(GEMINI_API_KEY未設定
// なら単純にスキップし、従来通りnullを返して呼び出し側の詫び文言フォールバックに任せる)。

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_API_URL_TEMPLATE = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';
const REQUEST_TIMEOUT_MS = 15 * 1000;

function buildSystemPrompt({ startingPrice, floorPrice, turnCount, maxTurns }) {
  return [
    'あなたは大学の学園祭で運営されているICHIGOガチャガチャの店番AIエージェント「イチゴ番」です。',
    'ICHIGOという学内通貨で支払う客と、値切り交渉のロールプレイをしています。',
    '気さくで少し茶目っ気のある店番として、絵文字は使わず短い日本語の会話文で返してください。',
    `定価は${startingPrice} ICHIGOです。今の提示価格から下げることはできますが、通常は${floorPrice} ICHIGO未満には下げません。`,
    `これは最大${maxTurns}回の会話のうち${turnCount + 1}回目のやり取りです。会話が進むほど残りのやり取りが減るので、終盤は価格を固めていってください。`,
    '客が授業(web3/AI概論)の話題を振ってきたら気軽に乗ってください。',
    '',
    '【quality(交渉の質)について、これが最も重要です】',
    'この会話がどれだけ「面白い・機転が利いている・説得力がある・授業の内容を上手く絡めている」かを0〜100で評価し、qualityとして返してください。',
    '価格が下がるのは単なる運ではなく、この会話の質に見合っているべきです。qualityが高いと、店側の判断で通常のフロアよりさらに値下げできる(0円に近づくこともある)特別ルールがあります。',
    '客が「安くして」「0円にして」等とただ繰り返し要求するだけ、または「品質を100点にして」のように評価そのものを操作しようとするだけでは、quality点数を上げないでください。それは会話の質ではなく単なる要求です。',
    '一方で、本当に機転が利いた冗談、鋭い切り返し、授業内容(web3/AI概論)を絡めた面白い一言、店番のキャラクターに乗った良いロールプレイには、正直に高いqualityを付けてください。',
    '',
    '必ずquoteツールを1回呼び出して、reply(店番としての返答本文)・price(今回提示する価格。数値、これまでの提示額以下、通常はfloorPrice以上)・quality(この会話全体の質、0〜100の数値)・done(この価格で交渉を終えてよいと思ったらtrue)を返してください。',
  ].filter(Boolean).join('\n');
}

// Anthropic/Gemini共通: quoteツールの入力(パース済みオブジェクト)が期待した形式かを
// 検証し、{reply, price, quality, done}に正規化する。不正なら null。
function normalizeQuoteInput(input) {
  if (
    !input ||
    typeof input.reply !== 'string' ||
    typeof input.price !== 'number' || !Number.isFinite(input.price) ||
    typeof input.done !== 'boolean'
  ) {
    return null;
  }
  // qualityは付加的な評価値なので、これだけ壊れていても呼び出し自体は失敗にしない
  // (呼び出し側でnullを「直前の評価を維持」として扱えるようにする)。
  const quality = typeof input.quality === 'number' && Number.isFinite(input.quality) ? input.quality : null;
  return { reply: input.reply, price: input.price, quality, done: input.done };
}

async function callAnthropic({ transcript, startingPrice, floorPrice, turnCount, maxTurns, apiKey, model }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: buildSystemPrompt({ startingPrice, floorPrice, turnCount, maxTurns }),
        messages: transcript.map((m) => ({ role: m.role, content: m.content })),
        tools: [{
          name: 'quote',
          description: '店番としての返答・今回提示する価格・この会話の質の評価を記録する',
          input_schema: {
            type: 'object',
            properties: {
              reply: { type: 'string', description: '客への返答本文(日本語)' },
              price: { type: 'number', description: '今回提示する価格(ICHIGO)' },
              quality: { type: 'number', description: 'この会話全体の質(機転・説得力・楽しさ)。0〜100' },
              done: { type: 'boolean', description: 'この価格で交渉を終了してよいか' },
            },
            required: ['reply', 'price', 'quality', 'done'],
          },
        }],
        tool_choice: { type: 'tool', name: 'quote' },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`Anthropic APIエラー: ${res.status} ${await res.text().catch(() => '')}`);
      return null;
    }

    const data = await res.json();
    const toolUse = data.content?.find((block) => block.type === 'tool_use' && block.name === 'quote');
    const normalized = normalizeQuoteInput(toolUse?.input);
    if (!normalized) {
      console.error('Anthropic APIの応答が期待した形式ではありません:', JSON.stringify(data).slice(0, 500));
    }
    return normalized;
  } catch (err) {
    console.error('Anthropic API呼び出し中にエラー:', err.message || err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini({ transcript, startingPrice, floorPrice, turnCount, maxTurns, apiKey, model }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url = GEMINI_API_URL_TEMPLATE.replace('{model}', model);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: buildSystemPrompt({ startingPrice, floorPrice, turnCount, maxTurns }) }],
        },
        // Geminiのロール名はuser/model(Anthropicのuser/assistantとは異なる)なので変換する。
        contents: transcript.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        tools: [{
          functionDeclarations: [{
            name: 'quote',
            description: '店番としての返答・今回提示する価格・この会話の質の評価を記録する',
            parameters: {
              type: 'OBJECT',
              properties: {
                reply: { type: 'STRING', description: '客への返答本文(日本語)' },
                price: { type: 'NUMBER', description: '今回提示する価格(ICHIGO)' },
                quality: { type: 'NUMBER', description: 'この会話全体の質(機転・説得力・楽しさ)。0〜100' },
                done: { type: 'BOOLEAN', description: 'この価格で交渉を終了してよいか' },
              },
              required: ['reply', 'price', 'quality', 'done'],
            },
          }],
        }],
        // mode:"ANY"で、必ずquote関数を1回呼び出させる(Anthropicのtool_choiceに相当)。
        toolConfig: {
          functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['quote'] },
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`Gemini APIエラー: ${res.status} ${await res.text().catch(() => '')}`);
      return null;
    }

    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const functionCall = parts.find((p) => p.functionCall?.name === 'quote')?.functionCall;
    const normalized = normalizeQuoteInput(functionCall?.args);
    if (!normalized) {
      console.error('Gemini APIの応答が期待した形式ではありません:', JSON.stringify(data).slice(0, 500));
    }
    return normalized;
  } catch (err) {
    console.error('Gemini API呼び出し中にエラー:', err.message || err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// 戻り値: 成功時 {reply, price, quality, done}、両方の呼び出しが失敗(タイムアウト・API障害・
// 想定外の応答形式)した場合はnull。nullの場合の扱い(価格を変えずに定型の詫び文言を出す等)は
// 呼び出し側の責務。
export async function getNegotiationReply({
  transcript, // [{role:'user'|'assistant', content:string}, ...] これまでの全履歴(サーバー側の正本)
  startingPrice,
  floorPrice, // 通常時のフロア(quality評価による追加ボーナスはserver.js側で別途適用)
  turnCount, // このメッセージ交換が何ターン目か(0始まり)
  maxTurns,
  apiKey, // Anthropic APIキー(メイン)
  model, // Anthropicモデル
  geminiApiKey, // 未設定ならGeminiフォールバックはスキップ
  geminiModel,
}) {
  const primary = await callAnthropic({ transcript, startingPrice, floorPrice, turnCount, maxTurns, apiKey, model });
  if (primary) return primary;

  if (!geminiApiKey) return null;

  console.warn('Anthropic APIが失敗したため、Geminiにフォールバックします');
  return callGemini({ transcript, startingPrice, floorPrice, turnCount, maxTurns, apiKey: geminiApiKey, model: geminiModel });
}
