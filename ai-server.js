// ai-server.js —— Folia 的 AI 主题生成小服务，跑在手机 Termux 上。
// 它接收 App 发来的歌词，转发给 AI，把生成的主题 JSON 返回给 App。
// 启动方法（在 Termux 里，任选一种）：
//   智谱：    ZHIPU_KEY=你的key node ~/ai-server.js
//   DeepSeek：DEEPSEEK_KEY=sk-你的key node ~/ai-server.js
//   任意兼容接口：OPENAI_KEY=sk-xxx OPENAI_BASE_URL=https://api.siliconflow.cn/v1 OPENAI_MODEL=Qwen/Qwen2.5-7B-Instruct node ~/ai-server.js
const http = require('http');

const PORT = 8787;
const ZHIPU_KEY = process.env.ZHIPU_KEY || '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || '';
const OPENAI_KEY = process.env.OPENAI_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || '';

// 把 base url 补全成 chat/completions 的完整地址
const buildChatUrl = (base) => {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
};

const PROVIDERS = {
  custom: {
    key: OPENAI_KEY,
    url: buildChatUrl(OPENAI_BASE_URL),
    model: OPENAI_MODEL,
  },
  deepseek: {
    key: DEEPSEEK_KEY,
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
  },
  zhipu: {
    key: ZHIPU_KEY,
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash',
  },
};

// 优先级：自定义接口 > DeepSeek > 智谱
const activeProvider = (OPENAI_KEY && OPENAI_BASE_URL && OPENAI_MODEL)
  ? PROVIDERS.custom
  : (DEEPSEEK_KEY ? PROVIDERS.deepseek : PROVIDERS.zhipu);

const SYSTEM_PROMPT = `You generate visual themes for a music player. Analyze the mood of the provided song source text and generate TWO visual theme configurations: one for LIGHT mode and one for DARK mode.

Rules:
1. Both themes capture the SAME emotional essence, with color palettes suited to their mode.
2. Theme names must be in Chinese, strictly 10 characters or less, reflecting mood AND mode (e.g. "忧郁破晓" for light, "忧郁子夜" for dark).
3. The description must be one brief emotional sentence in Chinese (15 to 30 Chinese characters), first-person listener perspective, stream-of-consciousness, poetic and youthful (e.g. "仿佛回到了那个满是汽水味和单车后座的夏天。").
4. If 'Pure instrumental' is yes, the source text is a song title of an instrumental track, not lyrics.
5. Pick 10-20 key emotional standalone words from the source text, assign each a fitting hex color under wordColors (Latin words without punctuation or spaces). These colors must harmonize with the overall palettes.
6. LIGHT theme: light background, diverse soft colors (not plain white); text dark enough for contrast (not pure black, use a dark tone matching the background hue). DARK theme: dark background (not generic pure black), light text, vivid accent.
7. lyricsIcons: 4-8 Lucide icon names related to the text (e.g. "sun", "moon", "cloud", "heart", "waves", "leaf", "star", "wind").
8. All color values must be hex codes like "#a1b2c3".

Respond with ONLY a JSON object, no markdown, no code fences, no explanation, exactly this shape:
{"light":{"name":"...","description":"...","backgroundColor":"#...","primaryColor":"#...","accentColor":"#...","secondaryColor":"#...","wordColors":[{"word":"...","color":"#..."}],"lyricsIcons":["..."]},"dark":{same fields}}`;

const sendJson = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
    if (data.length > 1024 * 1024) reject(new Error('body too large'));
  });
  req.on('end', () => resolve(data));
  req.on('error', reject);
});

const extractJson = (text) => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('AI 没有返回 JSON');
  return JSON.parse(text.slice(start, end + 1));
};

const askAiForTheme = async ({ lyricsText, isPureMusic, songTitle }) => {
  const userMsg = `Pure instrumental: ${isPureMusic ? 'yes' : 'no'}\nSong title: ${songTitle || 'unknown'}\nSource text:\n${lyricsText || ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch(activeProvider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${activeProvider.key}`,
      },
      body: JSON.stringify({
        model: activeProvider.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.7,
        max_tokens: 4096,
        stream: false,
      }),
      signal: controller.signal,
    });
    const raw = await resp.text();
    if (!resp.ok) {
      let detail = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw);
        detail = (parsed.error && parsed.error.message) || parsed.message || detail;
      } catch {}
      throw new Error(`AI 接口报错 (${resp.status}): ${detail}`);
    }
    const payload = JSON.parse(raw);
    const content = payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
    if (!content) throw new Error('AI 返回内容为空');
    const theme = extractJson(content);
    if (!theme.light || !theme.dark) throw new Error('AI 返回的主题缺少 light 或 dark');
    return theme;
  } finally {
    clearTimeout(timer);
  }
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/ping')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end('Folia AI server OK');
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/api/generate-theme')) {
    try {
      if (!activeProvider.key) {
        sendJson(res, 500, { error: 'Server configuration error' });
        return;
      }
      const body = JSON.parse(await readBody(req));
      console.log('[ai-server] 收到主题请求:', (body.songTitle || '').slice(0, 50));
      const theme = await askAiForTheme(body);
      console.log('[ai-server] 主题生成成功');
      sendJson(res, 200, theme);
    } catch (err) {
      console.error('[ai-server] 生成失败:', err.message);
      sendJson(res, 502, { error: err.message || 'AI 生成失败' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ai-server] 已启动，端口 ${PORT}，模型 ${activeProvider.model || '未配置'}`);
  if (!activeProvider.key || !activeProvider.url || !activeProvider.model) {
    console.log('[ai-server] 警告：没有正确设置密钥/地址/模型，收到请求会报错');
  }
});
