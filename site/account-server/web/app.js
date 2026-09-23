const el = (id) => document.getElementById(id);
let terms;
const messages = { sign_in_required: '请先登录。', agreement_required: '请先阅读并接受协议。', invalid_agreement: '协议已经更新，请刷新页面。', service_unavailable: '服务暂不可用，请稍后重试。旧账户尚未绑定时，请先完成账户迁移。', compute_not_connected: '请先连接算力账户。', compute_not_ready: '算力正在开通，请重新连接。' };
async function api(path, body) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(messages[data.error?.code] || '请求失败，请重试。'); }
  return response.status === 204 ? null : response.json();
}
async function load() {
  const response = await fetch('/v2/account/me', { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) return;
  if (!response.ok) throw new Error('账户服务暂不可用。');
  const data = await response.json();
  el('anonymous').hidden = true; el('profile').hidden = false;
  el('name').textContent = data.user.display_name; el('email').textContent = data.user.email; el('id').textContent = data.user.id;
  el('agreement').hidden = !data.agreement_required;
  el('compute').hidden = data.agreement_required;
  el('model-test').hidden = data.agreement_required || !data.compute_connected;
  el('compute-status').textContent = data.compute_connected ? '已关联算力账户。' : '账号已建立，可以连接算力服务。';
  if (data.agreement_required) { terms = await api('/v2/account/agreement'); el('terms').textContent = terms.text; }
}
function action(id, work) { el(id).addEventListener('click', async () => { el(id).disabled = true; el('notice').textContent = ''; try { await work(); } catch (error) { el('notice').textContent = error.message; } finally { el(id).disabled = false; } }); }
action('logout', async () => { await api('/v2/account/logout', {}); location.reload(); });
action('consent', async () => { if (!el('accepted').checked) throw new Error('请主动勾选协议后继续。'); await api('/v2/account/consent', { version: terms.version, content_hash: terms.content_hash, accepted: true }); await load(); });
action('connect', async () => { const result = await api('/v2/account/compute/connect', {}); const target = new URL(result.authorization_url); if (!['http:', 'https:'].includes(target.protocol)) throw new Error('登录地址无效。'); location.assign(target.href); });
action('refresh', async () => { el('quota').textContent = JSON.stringify(await api('/v2/account/compute'), null, 2); });
action('models', async () => { const data = await api('/v1/models'); el('model-list').textContent = (data.data || []).map(item => item.id).join('\n'); });
action('chat', async () => { const data = await api('/v1/chat/completions', { model: el('model').value, messages: [{ role: 'user', content: el('prompt').value }] }); el('answer').textContent = data.choices?.[0]?.message?.content || JSON.stringify(data); });
load().catch(error => { el('notice').textContent = error.message; });
