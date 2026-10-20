// Render the real selectors and CSS in an isolated Chromium fixture. No account
// credentials, paid requests, or installed-app state are used by this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const esbuild = require('esbuild');
const { chromium } = require(process.env.SOMNIQ_BROWSER_TEST_PACKAGE || 'playwright');
const desktop = path.resolve(__dirname, '..');
const output = path.resolve(process.env.SOMNIQ_PRICING_UI_OUTPUT || path.join(desktop, '../.somniq/runtime/model-pricing'));
const live = process.env.SOMNIQ_PRICING_UI_CATALOG
  ? JSON.parse(fs.readFileSync(process.env.SOMNIQ_PRICING_UI_CATALOG, 'utf8').replace(/^\uFEFF/, '')) : null;
// Only the normalized price data enters the fixture, with the account name removed.
if (live) live.username = 'fixture';
const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import ChatComposer from './src/chat/ChatComposer';
import ModelsSettings from './src/settings/ModelsSettings';
import {PREVIEW_SETTINGS_DATA} from './src/settings/settingsPreviewData';
import {pricingState} from './src/tests/modelPricingFixture';
import {useStore} from './src/store';
import './src/styles.css';
import './src/settings/SettingsLayout.css';
import './src/settings/GeneralSettings.css';
window.pricingFixture = ${live ? `{catalog:${JSON.stringify(live)},loading:false,stale:false,failed:false}` : 'pricingState()'};
const catalog=window.pricingFixture.catalog;
const models=catalog.models.filter(item=>!item.model.startsWith('gpt-image')).map(item=>item.model);
const view=new URLSearchParams(window.location.search).get('view')==='settings'?'settings':'chat';
function Fixture(){
  const [model,setModel]=useState('gpt-6.1-sol');
  const [reviewer,setReviewer]=useState('deepseek-v4.1-flash');
  const [pricing,setPricing]=useState(window.pricingFixture);
  window.updatePrices=value=>{window.pricingFixture=value;setPricing(value);};
  const language=useStore(state=>state.language);
  window.changeLanguage=value=>useStore.setState({language:value});
  window.changeTheme=value=>useStore.getState().setTheme(value);
  const connection={advForm:{},setAdvForm:()=>{},modelAutoSave:{error:''},loadManagedModels:()=>{},
    applyManagedModel:setModel,applyManagedReviewerModel:setReviewer,applyReviewMode:()=>{}};
  return <div className={'price-fixture price-fixture-'+view}>
    {view==='chat'?<main className="chat">
      <ChatComposer input="" onInputChange={()=>{}} commands={[]} skills={[]} attachments={[]}
        onAttachmentsChange={()=>{}} busy={false} ready editing={false}
        modelName={model} modelOptions={models.map(value=>({value,label:value}))}
        modelPricing={pricing} canSwitchModel onModelChange={setModel}
        reasoningSupported reasoningEffort="high" reasoningOptions={['low','medium','high']}
        onReasoningEffortChange={()=>{}} onSubmit={()=>{}} onStop={()=>{}} onCancelEdit={()=>{}} onHeightChange={()=>{}} />
    </main>:<aside className="sp-settings-shell"><div className="settings-page settings-page-models">
      <ModelsSettings language={language} account={null} managedModels={models} connection={connection}
        configView={{...PREVIEW_SETTINGS_DATA.cn.configView,executorModel:model,reviewerModel:reviewer}} />
    </div></aside>}
  </div>;
}
useStore.setState({language:'cn'});useStore.getState().setTheme('light');
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

async function screenshotPicker(page, filename) {
  const panel = page.locator('.chat-model-settings-panel');
  await page.mouse.move(0, 0);
  await panel.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
  const menu = await panel.boundingBox();
  const composer = await page.locator('.chat-input').boundingBox();
  const viewport = page.viewportSize();
  const x = Math.max(0, menu.x - 24);
  const y = Math.max(0, menu.y - 24);
  await page.screenshot({ path: path.join(output, filename), clip: {
    x, y, width: Math.min(viewport.width, composer.x + composer.width + 24) - x,
    height: Math.min(viewport.height, composer.y + composer.height + 24) - y,
  } });
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const result = await esbuild.build({
    stdin: { contents: fixture, resolveDir: desktop, loader: 'tsx' }, bundle: true, write: false,
    outfile: 'preview.js', format: 'esm', jsx: 'automatic', define: { 'import.meta.env': '{}' },
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.tex': 'text' },
    plugins: [{ name: 'fixture-pricing', setup(build) {
      build.onResolve({ filter: /(?:^|\/)useModelPricing$/ }, () => ({ path: 'pricing', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function useModelPricing(){return window.pricingFixture;}' }));
      build.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'preview-url' }));
      build.onLoad({ filter: /.*/, namespace: 'preview-url' }, () => ({ contents: 'export default "/unused-preview";' }));
    } }],
  });
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).contents;
  const css = result.outputFiles.find(file => file.path.endsWith('.css')).contents;
  const server = http.createServer((request, response) => {
    if (request.url === '/preview.js') { response.setHeader('content-type', 'text/javascript'); response.end(js); return; }
    if (request.url === '/preview.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/preview.css"><style>html,body,#root{height:100%;margin:0}.price-fixture{height:100%;min-width:0}.price-fixture>.chat{width:100%;height:100%}.price-fixture>.sp-settings-shell{height:100%;min-width:0;overflow:auto}.settings-page-models{padding:20px}</style></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.SOMNIQ_BROWSER_TEST_EXECUTABLE || undefined });
    const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    const trigger = page.locator('.chat-model-pill');
    await trigger.waitFor();
    assert.equal(await page.locator('.sp-settings-shell').count(), 0, 'Chat preview has no settings panel');
    for (const text of ['模型服务', 'Somni 绘图', '辅助模型', 'SomniQ · 模型价格']) {
      assert.equal(await page.getByText(text, { exact: true }).count(), 0, `Chat omits ${text}`);
    }
    assert.match(await trigger.locator('.chat-model-price').innerText(), /^[\d.]+×$/);
    assert.match(await trigger.getAttribute('title'), /1000.*Token/);
    const perRequestModels = await page.evaluate(() => window.pricingFixture.catalog.models
      .filter(price => price.billing === 'per_request' && !price.model.startsWith('gpt-image')).map(price => price.model));
    const perRequestGroups = new Map();
    const scenarios = [];
    for (const { theme, width } of ['light', 'dark'].flatMap(theme => [1500, 760, 420, 360].map(width => ({ theme, width })))) {
      await page.evaluate(theme => window.changeTheme(theme), theme);
      await page.setViewportSize({ width, height: 940 });
      await trigger.click();
      const panel = page.locator('.chat-model-settings-panel');
      await panel.waitFor();
      assert.equal(await panel.locator('.chat-model-price-basis').count(), 0, 'Chat shows price badges without a pricing paragraph');
      assert.doesNotMatch(await panel.innerText(), /高峰 = 1×|输入.*输出.*1:1/);
      await panel.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
      let singleModelGroups = 0;
      const perRequestLabelsChecked = new Set();
      const activeGroup = panel.locator('.chat-model-group-trigger[aria-expanded="true"]');
      const activeGroupName = await activeGroup.locator('span').first().innerText();
      for (const group of await panel.locator('.chat-model-group').all()) {
        const heading = group.locator('.chat-model-group-trigger');
        assert.equal(await heading.count(), 1, 'every series has a category heading');
        const count = Number(await heading.locator('.chat-model-group-count').innerText());
        if (await heading.getAttribute('aria-expanded') === 'false') {
          assert.equal(await group.getByRole('menuitemradio').count(), 0, 'collapsed categories hide their models');
          await heading.click();
        }
        assert.equal(await group.getByRole('menuitemradio').count(), count);
        assert.equal(await panel.getByRole('menuitemradio').count(), count, 'only one category is expanded');
        assert.doesNotMatch(await group.innerText(), /≈/);
        const priceOrder = await group.locator('.chat-model-price').allTextContents();
        const numericOrder = priceOrder.map(label => label === '免费' ? 0 : Number.parseFloat(label.replace(/^</, '')))
          .map(value => Number.isFinite(value) ? value : Infinity);
        assert.deepEqual(numericOrder, [...numericOrder].sort((a, b) => a - b), 'each category is ordered by ascending multiplier');
        for (const model of perRequestModels) {
          const option = group.getByRole('menuitemradio', { name: model, exact: true });
          if (!await option.count()) continue;
          assert.equal(await option.locator('.chat-model-price').innerText(), '0.1');
          assert.match(await option.getAttribute('title'), /按次计费/);
          perRequestLabelsChecked.add(model);
          perRequestGroups.set(model, await group.getAttribute('aria-label'));
        }
        if (count === 1) {
          assert.equal(await group.getByRole('menuitemradio').isVisible(), true);
          await heading.click();
          assert.equal(await group.getByRole('menuitemradio').count(), 0, 'single-model categories can collapse');
          singleModelGroups += 1;
        }
      }
      assert(singleModelGroups > 0, 'single-model series stay inside categories');
      assert.equal(perRequestLabelsChecked.size, perRequestModels.length);
      const currentGroup = panel.getByRole('menuitem', { name: activeGroupName, exact: true });
      if (await currentGroup.getAttribute('aria-expanded') !== 'true') await currentGroup.click();
      const selectedOption = panel.locator('.chat-model-option[aria-checked="true"]');
      assert.equal(await selectedOption.count(), 1);
      assert.equal(await selectedOption.evaluate(element => element.classList.contains('active')), true, 'selected model stays highlighted');
      assert.equal(await selectedOption.locator('svg').count(), 0, 'selected model has no checkmark');
      const bounds = await panel.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `menu fits ${width}px`);
      const badge = await trigger.locator('.chat-model-price').boundingBox();
      const button = await trigger.boundingBox();
      assert(badge.width > 0 && badge.x >= button.x && badge.x + badge.width <= button.x + button.width + 1, `badge stays visible at ${width}px`);
      assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth), true, `no horizontal overflow at ${width}px`);
      await page.screenshot({ path: path.join(output, `chat-model-prices-${theme}-${width}.png`), fullPage: true });
      if (width === 1500) await screenshotPicker(page, `chat-model-picker-${theme}.png`);
      scenarios.push({ theme, width, menu: bounds, badge, singleModelGroups, perRequestLabelsChecked: perRequestLabelsChecked.size });
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => window.changeTheme('light'));
    await page.setViewportSize({ width: 1500, height: 940 });
    const settingsPage = await browser.newPage({ viewport: { width: 1500, height: 940 } });
    settingsPage.on('pageerror', error => errors.push(error.message));
    await settingsPage.goto(`${url}/?view=settings`);
    const executor = settingsPage.getByRole('combobox', { name: '执行模型', exact: true });
    const reviewer = settingsPage.getByRole('combobox', { name: 'Reviewer 模型', exact: true });
    await executor.waitFor();
    assert.equal(await settingsPage.locator('.chat').count(), 0, 'Settings preview has no Chat composer');
    assert.match(await executor.locator('option:checked').innerText(), /[\d.]+×$/);
    assert.doesNotMatch(await executor.innerText(), /≈/);
    for (const model of perRequestModels) {
      for (const select of [executor, reviewer]) {
        assert.equal(await select.getByRole('option', { name: `${model} · 0.1`, exact: true }).count(), 1);
      }
    }
    await reviewer.selectOption('gpt-6.1-sol');
    assert.match(await reviewer.locator('option:checked').innerText(), /[\d.]+×$/);
    await executor.selectOption('deepseek-v4.1-flash');
    assert.equal(await executor.inputValue(), 'deepseek-v4.1-flash');
    assert.equal(await reviewer.inputValue(), 'gpt-6.1-sol');
    if (perRequestModels.length) {
      const model = perRequestModels[0];
      await trigger.click();
      await page.getByRole('menuitem', { name: perRequestGroups.get(model), exact: true }).click();
      await page.getByRole('menuitemradio', { name: model, exact: true }).click();
      assert.equal(await trigger.locator('.chat-model-price').innerText(), '0.1');
      assert.equal(await trigger.locator('.chat-model-pill-name').innerText(), model);
      await trigger.click();
      await screenshotPicker(page, 'chat-model-picker-per-request.png');
      await page.keyboard.press('Escape');
    }
    await trigger.click();
    const deepseekGroup = page.getByRole('menuitem', { name: 'DeepSeek', exact: true });
    if (await deepseekGroup.getAttribute('aria-expanded') !== 'true') await deepseekGroup.click();
    await page.getByRole('menuitemradio', { name: 'deepseek-v4.1-flash', exact: true }).click();
    assert.equal(await trigger.locator('.chat-model-pill-name').innerText(), 'deepseek-v4.1-flash');
    const otherModelPrice = await reviewer.locator('option:checked').innerText();
    const setOffPeak = offPeak => {
      const state = window.pricingFixture;
      const peak = state.catalog.peakBaseline;
      const current = { ...peak, tier: offPeak ? 'off_peak' : 'peak' };
      for (const key of ['inputRate','outputRate','cacheReadRate','cacheCreationRate']) {
        if (current[key] !== null) current[key] *= offPeak ? 0.5 : 1;
      }
      window.updatePrices({ ...state, catalog: { ...state.catalog, models: state.catalog.models.map(price => price.model === peak.model ? current : price) } });
    };
    for (const offPeak of [false, true]) {
      await page.evaluate(setOffPeak, offPeak);
      await settingsPage.evaluate(setOffPeak, offPeak);
      assert.match(await trigger.innerText(), offPeak ? /0\.5×/ : /\b1×/);
      assert.equal(await reviewer.locator('option:checked').innerText(), otherModelPrice);
      assert.match(await settingsPage.locator('.settings-model-price-basis').innerText(), /高峰 = 1×/);
    }
    await trigger.click();
    await page.locator('.chat-model-settings-panel').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
    await page.screenshot({ path: path.join(output, 'chat-model-prices-off-peak.png'), fullPage: true });
    await screenshotPicker(page, 'chat-model-picker.png');
    await settingsPage.screenshot({ path: path.join(output, 'settings-model-prices-off-peak.png'), fullPage: true });
    await settingsPage.evaluate(() => window.changeTheme('dark'));
    await settingsPage.screenshot({ path: path.join(output, 'settings-model-prices-dark.png'), fullPage: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'layout.json'), JSON.stringify({ outcome: 'passed', scenarios, ascendingPricesWithinGroups: true, approximationSign: false, badgeStyle: 'pill', themes: ['light', 'dark'], selectedModelHighlightOnly: true, allModelsCategorized: true, perRequestLabel: '0.1', chatOnly: true, separateSettingsPreview: true, visiblePricingSummary: false, fixedPeakBaseline: true, offPeakMultiplier: 0.5, independentRoles: true, errors }, null, 2));
    console.log('Model prices: multiplier pills without approximation signs, light/dark themes at 4 widths, selected model highlighted without a checkmark, categories, per-request label 0.1, fixed peak baseline, off-peak discount and independent roles passed.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
