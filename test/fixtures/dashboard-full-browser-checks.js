(async () => {
  if (location.hostname !== '127.0.0.1') throw Error('Isolated loopback fixture required');
  const assert = (value, message) => { if (!value) throw Error(message); };
  const waitFor = async (condition, message) => {
    const deadline = Date.now() + 15000;
    while (!condition()) { if (Date.now() > deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 40)); }
  };
  const control = async route => { const response = await fetch(route, { method: 'POST' }); assert(response.ok, route); return response.json(); };
  const fixture = await (await fetch('/__fixture/status')).json();
  const id = fixture.topicId;
  document.querySelector('.main-topic[data-topic="engineering"]').click();
  await waitFor(() => document.querySelector(`.topic-open[data-topic-id="${id}"]`), 'topic list');
  document.querySelector(`.topic-open[data-topic-id="${id}"]`).click();
  await waitFor(() => selectedTopicAssets?.clean?.length === 7 && durableData?.execution === 'awaiting_user_review', 'topic load');
  assert(durableData.quality === 'pass' && durableData.userApproval === 'pending', 'machine PASS must not imply user approval');
  assert(document.getElementById('durable-start').disabled, 'duplicate start disabled');
  document.getElementById('durable-info-review').click();
  await waitFor(() => activeWorkbenchPane === 'info', 'durable INFO button must open actual INFO tab');
  assert(document.querySelector('#workbench-pane-info img'), 'actual INFO images');
  document.getElementById('durable-clean-review').click();
  await waitFor(() => activeWorkbenchPane === 'assets', 'durable CLEAN button must open actual CLEAN tab');

  await control('/__fixture/mutate?kind=clean&mode=stale');
  await loadAssetReview();
  assert(selectedTopicAssets.clean[0].status === 'REPLACE_CANDIDATE', 'mutated bytes cannot remain AI_PASS/OK');
  assert(workbenchNextButton.dataset.action !== 'finalize-clean-and-generate-info', 'stale final approval disabled');
  openAssetViewer(0, 'clean');
  assert(assetViewerDetail.querySelector('[data-review-asset="OK"]').disabled, 'stale individual approval disabled');
  closeAssetViewer();
  let rejected = await fetch('/api/assets/clean/finalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicId: id }) });
  assert(!rejected.ok, 'server must reject stale finalize');
  await control('/__fixture/mutate?kind=clean&mode=restore');
  await control('/__fixture/mutate?kind=info&mode=missing');
  await loadAssetReview();
  assert(selectedTopicAssets.info.length === 6, 'missing asset excluded');
  rejected = await fetch('/api/assets/info/finalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicId: id }) });
  assert(!rejected.ok, 'server must reject missing finalize');
  await control('/__fixture/mutate?kind=info&mode=restore');

  await control('/__fixture/delay?ms=400');
  const oldSelection = openTopicWorkbench(id);
  await new Promise(resolve => setTimeout(resolve, 40));
  await openTopicWorkbench(fixture.secondTopicId);
  await oldSelection;
  await waitFor(() => durableData?.topicId === fixture.secondTopicId, 'second durable status');
  assert(selectedTopicDetail.topic.id === fixture.secondTopicId, 'older detail cannot overwrite selected topic');
  assert(workbenchTitle.textContent.includes('Synthetic B'), 'selected topic title race');
  assert(!selectedTopicAssets?.clean?.length, 'old assets cannot overwrite new topic');
  await control('/__fixture/delay?ms=0');
  await openTopicWorkbench(id);
  await waitFor(() => durableData?.execution === 'awaiting_user_review', 'restored topic');

  for (const [prefix, load] of [['/api/assets?', loadAssetReview], ['/api/tts/plan?', loadTtsPlan]]) {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).startsWith(`${prefix}topicId=${id}`)) await new Promise(resolve => setTimeout(resolve, 350));
      return response;
    };
    try {
      const delayed = load();
      await new Promise(resolve => setTimeout(resolve, 40));
      await openTopicWorkbench(fixture.secondTopicId);
      await delayed;
      assert(selectedTopicDetail.topic.id === fixture.secondTopicId && !selectedTopicAssets?.clean?.length && !latestTtsRun, 'delayed asset/TTS response cannot overwrite new selection');
    } finally { window.fetch = originalFetch; }
    await openTopicWorkbench(id);
    await waitFor(() => durableData?.execution === 'awaiting_user_review', 'restored topic after response race');
  }

  // These clicks approve only synthetic files in this dedicated fixture.
  const currentHash = selectedTopicAssets.clean[0].contentHash;
  openAssetViewer(0, 'clean');
  assetViewerDetail.querySelector('[data-review-asset="OK"]').click();
  await waitFor(() => durableData?.evidence?.some(row => row.kind === 'clean' && row.clipKey === '1' && row.userApproval === 'approved'), 'individual current-hash approval');
  closeAssetViewer();
  const afterSingle = await (await fetch('/__fixture/status')).json();
  const firstReview = afterSingle.reviews.find(row => row.asset_type === 'clean' && row.clip_index === 1);
  const provenance = JSON.parse(firstReview.auto_qc_json).manualProvenance;
  assert(provenance.assetHashBefore === currentHash && provenance.assetHashAfter === currentHash, 'approval binds viewed/current bytes');
  assert(durableData.userApproval === 'pending', 'partial approval not full approval');
  await openDurableReview('assets');
  assert(workbenchNextButton.dataset.action === 'finalize-clean-and-generate-info', 'existing CLEAN finalize action');
  workbenchNextButton.click();
  await waitFor(() => activeWorkbenchPane === 'info' && selectedTopicAssets.clean.every(row => row.status === 'OK'), 'CLEAN final approval');
  await waitFor(() => !workbenchNextButton.disabled && workbenchNextButton.dataset.action === 'finalize-info', 'INFO finalize ready');
  workbenchNextButton.click();
  await waitFor(() => durableData?.userApproval === 'approved' && selectedTopicAssets.info.every(row => row.status === 'OK'), 'INFO approval refreshes durable state');
  assert(activeWorkbenchPane === 'info', 'approval must not enter video');
  assert(workbenchNextButton.disabled && workbenchNextButton.dataset.action === '', 'next action must not generate video');
  await refreshWorkbenchDetail();
  await openTopicWorkbench(id);
  await loadVideoPlan();
  setWorkbenchPane('video');
  assert(activeWorkbenchPane === 'info', 'automatic refresh/reopen must stay in review');
  const after = await (await fetch('/__fixture/status')).json();
  assert(after.run.status === 'awaiting_user_review', 'no invented terminal complete');
  assert(!after.calls.some(row => /^\/api\/(video|edit)/.test(row.path)), 'no H3/video/edit automatic entry');
  assert(!after.calls.some(row => row.method === 'POST' && !/^\/api\/assets\//.test(row.path)), 'no generation POST');
  const evidence = { passed: true, topicId: id, runId: after.run.id, fullPage: location.href, machineQuality: 'pass', userApproval: 'approved', execution: after.run.status, checks: ['topic-click', 'CLEAN-tab', 'INFO-tab', 'stale-final-rejected', 'stale-individual-disabled', 'missing-final-rejected', 'selected-topic-race', 'current-hash-approval', 'partial-not-full-approval', 'explicit-CLEAN-INFO-finalize', 'refresh-no-video', 'no-generation-post'], requestCount: after.calls.length };
  window.dashboardBrowserEvidence = evidence;
  return evidence;
})()
