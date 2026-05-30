import fs from 'fs';
import yaml from 'yaml';

// 直接从 config.yaml 解析
const configContent = fs.readFileSync('./config.yaml', 'utf8');
const config = yaml.parse(configContent);

// 只测未注释的 provider
const activeModels = [];
for (const provider of (config.providers ?? [])) {
  const { name, type, api_key, base_url, models = [] } = provider;
  if (!api_key || !base_url || models.length === 0) continue;
  for (const model of models) {
    activeModels.push({ provider: name, model, type, apiKey: api_key, baseUrl: base_url });
  }
}

console.log(`待测试模型数量: ${activeModels.length}\n`);
activeModels.forEach(m => console.log(`  [${m.provider}] ${m.model}`));
console.log('');

const results = { free: [], paid: [], error: [] };

async function testModel(entry) {
  const { provider, model, type, apiKey, baseUrl } = entry;

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 5,
    stream: false,
  });

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // OpenRouter 需要额外头
  if (baseUrl.includes('openrouter')) {
    headers['HTTP-Referer'] = 'https://test.local';
    headers['X-Title'] = 'ModelTest';
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 20000);

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(tid);
    const status = resp.status;
    const text = await resp.text();

    if (status === 200) {
      results.free.push({ provider, model, status });
      process.stdout.write(`[FREE]   ${status}  ${provider}/${model}\n`);
    } else if (status === 429 || status === 402 || status === 403) {
      results.paid.push({ provider, model, status, body: text.slice(0, 120) });
      process.stdout.write(`[PAID]   ${status}  ${provider}/${model}\n`);
    } else {
      results.error.push({ provider, model, status, body: text.slice(0, 120) });
      process.stdout.write(`[ERROR]  ${status}  ${provider}/${model}  ${text.slice(0, 60)}\n`);
    }
  } catch (err) {
    clearTimeout(tid);
    if (err.name === 'AbortError') {
      results.error.push({ provider, model, status: 0, body: 'timeout' });
      process.stdout.write(`[TIMEOUT]       ${provider}/${model}\n`);
    } else {
      results.error.push({ provider, model, status: 0, body: err.message });
      process.stdout.write(`[NETERR]        ${provider}/${model}  ${err.message}\n`);
    }
  }
}

async function main() {
  for (const entry of activeModels) {
    await testModel(entry);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n========== 结果汇总 ==========');
  console.log(`免费可用: ${results.free.length}`);
  console.log(`付费/限速: ${results.paid.length}`);
  console.log(`错误:     ${results.error.length}`);

  fs.writeFileSync('./model_test_results.json', JSON.stringify(results, null, 2));

  if (results.free.length > 0) {
    console.log('\n确认可用的模型:');
    results.free.forEach(m => console.log(`  ${m.provider}/${m.model}`));
  }

  const toComment = [...results.paid, ...results.error.filter(e => e.status !== 402 && e.status !== 403 && e.status !== 429)];
  if (toComment.length > 0) {
    console.log('\n建议注释掉的模型:');
    toComment.forEach(m => console.log(`  ${m.provider}/${m.model} (${m.status || 'timeout'})`));
  }
}

main().catch(console.error);