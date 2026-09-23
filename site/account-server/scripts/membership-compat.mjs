import assert from 'node:assert/strict';
const tiers = { go: ['gpt-4o-mini'], plus: ['gpt-4o', 'gpt-4o-mini'], pro: ['gpt-4', 'gpt-4o', 'gpt-4o-mini'] };
async function assign(call, user, plan, expires = Math.floor(Date.now() / 1000) + 3600) {
  const current = await call('/v2/account/entitlements');
  const result = await call('/v2/admin/users/' + user + '/membership', 'PUT', {
    plan_id: plan, expires_at: plan ? expires : null,
    expected_revision: current.value.membership_revision, reason: 'Isolated compatibility validation',
  });
  assert.equal(result.status, 200, 'membership assignment');
}
export async function configureMembership(call, user) {
  const plans = await call('/v2/admin/plans');
  assert.equal(plans.status, 200, 'configured OIDC subject is administrator');
  for (const plan of plans.value) {
    const models = tiers[plan.id];
    const result = await call('/v2/admin/plans/' + plan.id, 'PUT', {
      models, default_executor: models[0], default_reviewer: models[0], enabled: true, expected_revision: plan.revision,
    });
    assert.equal(result.status, 200, 'publish ' + plan.id);
  }
  await assign(call, user, 'go');
}
export async function exerciseMembership(call, user) {
  const catalog = await call('/v2/catalog/plans');
  assert.deepEqual(catalog.value.plans.map(p => p.amount_fen), [2900, 4900, 9900]);
  assert.ok(catalog.value.plans.every(p => p.billing_period === 'month'));
  const discovery = await call('/v2/admin/models');
  assert.equal(discovery.status, 200);
  assert.ok(discovery.value.models.includes('gpt-4o-mini'));
  for (const [tier, allowed] of Object.entries(tiers)) {
    await assign(call, user, tier);
    const models = await call('/v1/models');
    assert.equal(models.status, 200, 'models for ' + tier);
    assert.deepEqual(models.value.data.map(m => m.id).sort(), allowed);
    for (const model of tiers.pro) {
      const response = await call('/v1/chat/completions', 'POST', { model, messages: [{ role: 'user', content: 'Membership test' }] });
      assert.equal(response.status, allowed.includes(model) ? 200 : 403, tier + ' authorization: ' + model);
    }
  }
  await assign(call, user, 'go');
  assert.equal((await call('/v1/chat/completions', 'POST', { model: 'gpt-4', messages: [] })).status, 403, 'downgrade blocks premium immediately');
  await assign(call, user, null);
  assert.equal((await call('/v1/chat/completions', 'POST', { model: 'gpt-4o-mini', messages: [] })).status, 403, 'revocation');
  await assign(call, user, 'go', Math.floor(Date.now() / 1000) + 2);
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal((await call('/v1/chat/completions', 'POST', { model: 'gpt-4o-mini', messages: [] })).status, 403, 'expiry requires no timer');
  await assign(call, user, 'go');
  assert.ok((await call('/v2/admin/audit')).value.events.length >= 10, 'auditable changes');
}
