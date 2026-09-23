import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { exerciseMembership } from './membership-compat.mjs';

export async function browserSmoke({ origin, password, stopCompute, scratch }) {
  const browser = await puppeteer.launch({ headless: true, args: process.env.CI ? ['--no-sandbox'] : [] });
  let page;
  try {
    page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(`${origin}/account.html?lang=en`);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.waitForSelector('a[href="/v2/account/login"]');
    await page.click('a[href="/v2/account/login"]');
    await page.waitForSelector('#username');
    assert.ok(await page.$('a[href*="registration"]'), 'Keycloak offers registration');
    assert.ok(await page.$('a[href*="reset-credentials"]'), 'Keycloak offers account recovery');
    await page.type('#username', 'alice'); await page.type('#password', password);
    await page.click('#kc-login');
    await page.waitForSelector('[data-testid="account-name"]');
    assert.ok(await page.$('.console-header .console-user-pill'), 'account keeps the original console header');
    assert.ok(await page.$('.console-sidebar .console-nav'), 'account keeps the original sidebar');
    const me = () => page.evaluate(async () => (await fetch('/v2/account/me')).json());
    const initial = await me();
    assert.equal(initial.user.email, 'alice@example.invalid');
    assert.equal(initial.agreement_required, true);
    assert.match(initial.user.id, /^[a-f0-9-]{36}$/);
    await page.waitForSelector('[data-testid="agreement-checkbox"]');
    await page.click('[data-testid="agreement-checkbox"]');
    await page.click('[data-testid="accept-agreement"]');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Connect compute')));
    const click = async text => page.evaluate(text => [...document.querySelectorAll('button')].find(b => b.textContent.includes(text)).click(), text);
    await click('Connect compute');
    await page.waitForSelector('[data-testid="compute-metrics"]');
    assert.equal((await me()).compute_connected, true);
    assert.equal((await me()).is_admin, true);
    await page.goto(origin + '/admin.html');
    await page.waitForSelector('[data-testid="edit-go"]');
    assert.ok(await page.$('.console-sidebar .console-nav-item--active'), 'admin is embedded in the console');
    const adminClick = async text => page.evaluate(text => [...document.querySelectorAll('button')].find(b => b.textContent.includes(text)).click(), text);
    await adminClick('从 New API 读取模型');
    await page.waitForSelector('.admin-model-picker input');
    const tiers = { go: ['gpt-4o-mini'], plus: ['gpt-4o', 'gpt-4o-mini'], pro: ['gpt-4', 'gpt-4o', 'gpt-4o-mini'] };
    for (const [tier, models] of Object.entries(tiers)) {
      await page.click('[data-testid="edit-' + tier + '"]');
      await page.waitForFunction(name => document.querySelector('.admin-panel h2')?.textContent.startsWith(name), {}, { go: 'Go', plus: 'Plus', pro: 'Pro' }[tier]);
      await page.type('[data-testid="plan-models"]', models.join('\n'));
      await page.click('[data-testid="plan-enabled"]');
      await page.click('[data-testid="save-plan"]');
      await page.waitForFunction(() => document.querySelector('.admin-revision')?.textContent.includes('2'));
      assert.ok(await page.$eval('[data-testid="plan-models"]', e => e.value.includes('gpt-4o-mini')));
    }
    await page.screenshot({ path: join(scratch, 'site-admin-plans-desktop.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'admin mobile has no overflow');
    await page.screenshot({ path: join(scratch, 'site-admin-plans-mobile.png'), fullPage: true });
    await page.setViewport({ width: 1280, height: 1000 });
    await page.click('[data-testid="tab-users"]');
    await page.click('[data-testid="select-user-' + initial.user.id + '"]');
    await page.select('[data-testid="member-plan"]', 'go');
    await page.type('[data-testid="member-reason"]', 'Browser validation membership');
    await page.click('[data-testid="save-membership"]');
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('会员已更新'));
    await page.screenshot({ path: join(scratch, 'site-admin-members-desktop.png'), fullPage: true });
    const memberCall = (path, method = 'GET', data) => page.evaluate(async ({ path, method, data }) => {
      const response = await fetch(path, { method, headers: { 'content-type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, value: await response.json() };
    }, { path, method, data });
    await exerciseMembership(memberCall, initial.user.id);
    await page.goto(origin + '/dashboard.html?lang=en&tab=plan');
    await page.waitForSelector('[data-testid="membership-plan-go"]');
    assert.ok((await page.$eval('[data-testid="membership-plan-go"]', e => e.textContent)).includes('29'));
    assert.ok((await page.$eval('[data-testid="membership-plan-pro"]', e => e.textContent)).includes('99'));
    await page.goto(origin + '/pricing.html?lang=en');
    await page.waitForSelector('[data-testid="membership-plan-pro"]');
    assert.ok((await page.$eval('[data-testid="membership-plan-pro"]', e => e.textContent)).includes('99'));
    await page.screenshot({ path: join(scratch, 'site-membership-pricing-desktop.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'pricing mobile has no overflow');
    await page.screenshot({ path: join(scratch, 'site-membership-pricing-mobile.png'), fullPage: true });
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(origin + '/account.html?lang=en');
    await page.waitForSelector('[data-testid="compute-metrics"]');
    const result = await page.evaluate(async () => {
      const models = await (await fetch('/v1/models')).json();
      const stream = await fetch('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Compatibility test' }], stream: true }) });
      return { models: models.data.map(m => m.id), status: stream.status, text: await stream.text(), storageKeys: Object.keys(localStorage) };
    });
    assert.ok(result.models.includes('gpt-4o-mini')); assert.equal(result.status, 200); assert.ok(result.text.includes('[DONE]'));
    assert.ok(result.storageKeys.every(key => !/token|account_profile|access/i.test(key)), 'browser stores no account or upstream credentials');
    await page.screenshot({ path: join(scratch, 'site-account-desktop.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile has no horizontal overflow');
    await page.screenshot({ path: join(scratch, 'site-account-mobile.png'), fullPage: true });
    // Wait for the redirect chain to finish: the old page still has its usage
    // panel briefly while the connection request is in flight.
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }), click('Reconnect')]);
    await page.waitForSelector('[data-testid="compute-metrics"]');
    await page.click('[data-testid="account-logout"]'); await page.waitForSelector('a[href="/v2/account/login"]');
    assert.equal(await page.evaluate(async () => (await fetch('/v2/account/me')).status), 401);
    await page.click('a[href="/v2/account/login"]'); await page.waitForSelector('[data-testid="compute-metrics"]');
    const again = await me(); assert.equal(again.user.id, initial.user.id); assert.equal(again.agreement_required, false);
    await stopCompute();
    await page.reload(); await page.waitForSelector('[data-testid="account-name"]');
    assert.equal((await me()).user.id, initial.user.id);
    await page.waitForFunction(() => document.body.textContent.includes('Compute is temporarily unavailable'));
    assert.deepEqual(errors, []);
    return ['real Keycloak login + PKCE', 'registration/recovery links', 'Site explicit agreement', 'real New API OIDC account and model key', 'browser HttpOnly account session', 'admin plan editor and member assignment', 'Go/Plus/Pro model permission matrix', 'monthly prices 29/49/99', 'downgrade/revoke/expiry', 'streamed model response', 'quota display', 'desktop/mobile layout', 'repeat connection', 'logout and stable re-login', 'Site identity survives New API outage'];
  } catch (error) {
    if (page) {
      await page.screenshot({ path: join(scratch, 'browser-failure.png'), fullPage: true });
      await writeFile(join(scratch, 'browser-failure.txt'), await page.evaluate(() => `${location.origin}${location.pathname}\n${document.body.innerText}`));
    }
    throw error;
  } finally { await browser.close(); }
}
