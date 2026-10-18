const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const response = value => ({ ok: true, status: 200, json: async () => value });
const project = (id = 'p1') => ({ id, title: id, goal: 'Cerita', idea: '', status: 'Draft', platform: 'flow', data: { scenes: [], assets: [], checks: {} } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function appContext({ fetchImpl, storageImpl, projects = [], confirmImpl, clipboardImpl } = {}) {
  const elements = new Map();
  const session = new Map();
  const handlers = {};
  let scrolls = 0;
  let confirms = 0;
  const confirmMessages = [];
  const makeElement = () => ({
    value: '', textContent: '', innerHTML: '', disabled: false, dataset: {},
    classList: {
      names: new Set(),
      add(name) { this.names.add(name); },
      remove(name) { this.names.delete(name); },
      contains(name) { return this.names.has(name); },
      toggle(name) { if (this.names.has(name)) this.names.delete(name); else this.names.add(name); },
    },
    addEventListener() {}, focus() {}, showModal() {}, close() {}, reset() {}, options: [],
    querySelector() { return makeElement(); }, querySelectorAll() { return []; },
    closest() { return null; },
  });
  const document = {
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, makeElement()); return elements.get(selector); },
    querySelectorAll() { return []; },
    addEventListener(type, handler) { handlers[type] = handler; },
  };
  const storage = storageImpl || {
    setItem: (key, value) => session.set(key, value),
    getItem: key => session.get(key) ?? null,
    removeItem: key => session.delete(key),
  };
  const fetch = fetchImpl || (async (url, options) => {
    if (options?.method === 'PUT') return response(JSON.parse(options.body));
    if (url === '/api/projects') return response(projects);
    return response({});
  });
  const context = vm.createContext({
    document, window: { scrollTo() { scrolls++; } }, crypto: { randomUUID: () => `id-${Math.random()}` },
    navigator: { clipboard: { writeText: clipboardImpl || (async () => {}) } }, sessionStorage: storage,
    setTimeout: () => 1, clearTimeout() {}, confirm: message => { confirms++; confirmMessages.push(message); return confirmImpl ? confirmImpl(message) : true; }, prompt: () => null,
    fetch, console,
  });
  vm.runInContext(fs.readFileSync(require.resolve('../static/app.js'), 'utf8'), context);
  function click({ id, tab, view, open, deleteAsset, linkAll, copyClip, copyLang, style, copyChar, copyScene, copyEntity, resetPrompt, resultStatus, resultId, flowStart } = {}) {
    const target = {
      id, dataset: { deleteAsset, linkAll, copyClip, copyLang, style, copyChar, copyScene, copyEntity, resetPrompt, resultStatus, resultId, flowStart },
      closest(selector) {
        if (selector === '[data-tab]' && tab) return { dataset: { tab } };
        if (selector === '[data-view]' && view) return { dataset: { view } };
        if (selector === '[data-open]' && open) return { dataset: { open } };
        return null;
      },
    };
    return handlers.click({ target });
  }
  return {
    context, elements, session, click, confirmMessages,
    change: target => handlers.change({ target }),
    input: target => handlers.input({ target }),
    element: selector => document.querySelector(selector),
    getScrolls: () => scrolls, getConfirms: () => confirms,
  };
}

test('checklist status ignores removed-scene keys and handles empty scenes', () => {
  const { context } = appContext();
  const result = vm.runInContext(`calculateChecklistStatus([{id:'active'}], {
    'scene-active-assets':true, 'scene-active-prompt':true, 'scene-old-generated':true,
    'scene-old-collected':true, 'scene-active-collected':false
  })`, context);
  assert.equal(result.status, 'Prompt siap');
  assert.equal(result.collected, 0);
  assert.equal(vm.runInContext(`calculateChecklistStatus([], {'scene-old-collected':true}).status`, context), 'Menyiapkan produksi');
});

test('legacy dialogue and audio fields normalize to separate backward-compatible audio categories', () => {
  const { context } = appContext();
  const result = vm.runInContext(`(()=>{const d=normalizeProductionData({scenes:[{id:'old',dialogue:'Halo',audio:{voiceover:'Narasi',music:'Piano',effects:['Pintu']}}]});return d.scenes[0]})()`, context);
  assert.equal(result.audioPlan.dialogue[0].text, 'Halo');
  assert.equal(result.audioPlan.voiceover.text, 'Narasi');
  assert.equal(result.audioPlan.music.description, 'Piano');
  assert.deepEqual(Array.from(result.audioPlan.soundEffects), ['Pintu']);
  assert.equal(result.audio.voiceover, 'Narasi');
});

test('10-second scene estimates dialogue and voiceover length and warns when speech exceeds clip', () => {
  const { context } = appContext();
  const fit = vm.runInContext(`audioSpeechEstimate({duration:'10 detik',audioPlan:{required:true,dialogue:[{text:'satu dua tiga empat lima enam tujuh delapan sembilan sepuluh'}],voiceover:{text:''}}})`, context);
  assert.equal(fit.speechSeconds, 4);
  assert.equal(fit.overLimit, false);
  const estimate = vm.runInContext(`audioSpeechEstimate({duration:'10 detik',audioPlan:{required:true,dialogue:[{text:'satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua belas tiga belas empat belas lima belas enam belas tujuh belas delapan belas sembilan belas dua puluh dua puluh satu dua puluh dua dua puluh tiga dua puluh empat dua puluh lima'}],voiceover:{text:''}}})`, context);
  assert.equal(estimate.clipSeconds, 10);
  assert.equal(estimate.speechSeconds, 18);
  assert.equal(estimate.overLimit, true);
  const over = vm.runInContext(`audioSpeechEstimate({duration:'10 detik',audioPlan:{required:true,dialogue:[{text:'${'kata '.repeat(30).trim()}'}],voiceover:{text:''}}})`, context);
  assert.equal(over.overLimit, true);
});

test('editing dialog fields creates and updates a structured speaker entry', () => {
  const { context } = appContext();
  const entry = vm.runInContext(`(()=>{const a={dialogue:[]};setAudioPath(a,'dialogue.speakerName','Ayu');setAudioPath(a,'dialogue.text','Halo');return a.dialogue[0]})()`, context);
  assert.equal(entry.speakerName, 'Ayu');
  assert.equal(entry.text, 'Halo');
});

test('audio continuity, dialogue, voiceover, music, and effects agree between prompt and production JSON', () => {
  const { context } = appContext();
  const result = vm.runInContext(`(()=>{const p={title:'Audio',platform:'flow',goal:'Cerita',idea:'Ide',data:{duration:'10 detik',audioDirector:{continuityNotes:'Suara narator rendah dan tenang di semua scene'},scenes:[{id:'s1',title:'Awal',duration:'10 detik',audioPlan:{required:true,dialogue:[{speakerName:'Ayu',speakerId:'ayu',voiceProfileId:'ayu-v1',voiceProfile:'lembut',text:'Ayo pulang',emotion:'lega',delivery:'pelan'}],voiceover:{narratorName:'Narator',voiceProfileId:'narator-v1',voiceProfile:'bariton',text:'Senja tiba',emotion:'hangat',delivery:'tenang'},music:{description:'Piano',mood:'hangat',continuityId:'theme-1',transition:'fade'},ambience:['hujan'],soundEffects:['langkah']}}],assets:[]}};const d=normalizeProductionData(p.data,p);const scene=d.scenes[0];return{prompt:makePrompt(scene,platforms.flow,d,p),pack:buildSceneProduction(p,platforms.flow,scene)}})()`, context);
  for (const phrase of ['Ayu', 'ayu-v1', 'Narator', 'narator-v1', 'Piano', 'hujan', 'langkah', 'theme-1', 'Suara narator rendah']) assert.ok(result.prompt.includes(phrase), phrase);
  assert.equal(result.pack.scene.audioPlan.dialogue[0].voiceProfileId, 'ayu-v1');
  assert.equal(result.pack.scene.audioPlan.voiceover.voiceProfileId, 'narator-v1');
  assert.equal(result.pack.audioDirector.continuityNotes, 'Suara narator rendah dan tenang di semua scene');
  assert.equal(result.pack.audioEstimate.clipSeconds, 10);
  assert.ok(result.prompt.includes('audio belum dibuat'));
});

test('audio checklist is required only for scenes that need an audio plan', () => {
  const { context } = appContext();
  const ordinary = vm.runInContext(`calculateChecklistStatus([{id:'old',productionChecklist:{assets:true,prompt:true,generated:true,collected:true}}],{})`, context);
  assert.equal(ordinary.status, 'Klip sudah dikumpulkan');
  const planned = vm.runInContext(`calculateChecklistStatus([{id:'new',audioPlan:{required:true},productionChecklist:{assets:true,prompt:true,generated:true,collected:true,audio:false}}],{})`, context);
  assert.equal(planned.status, 'Klip sedang diproduksi');
  assert.equal(planned.collected, 1);
});

test('late success from an older save cannot clear the newest failed draft', async () => {
  const calls = [];
  const { context, session } = appContext({ fetchImpl: (url, options) => {
    if (options?.method === 'PUT') {
      const d = deferred();
      calls.push({ d, body: JSON.parse(options.body) });
      return d.promise;
    }
    return Promise.resolve(response([]));
  } });
  vm.runInContext(`current=${JSON.stringify(project())};activeTab='idea'`, context);
  const oldSave = vm.runInContext('saveNow()', context);
  while (calls.length < 1) await tick();
  vm.runInContext(`current.idea='newest draft';scheduleSave()`, context);
  const newestSave = vm.runInContext('saveNow()', context);
  calls[0].d.resolve(response(calls[0].body));
  assert.equal(await oldSave, false);
  assert.equal(JSON.parse(session.get('ai-video-studio:unsaved:p1')).idea, 'newest draft');
  assert.notEqual(vm.runInContext(`saveMessages.get('p1')`, context), 'Perubahan tersimpan');
  while (calls.length < 2) await tick();
  calls[1].d.reject(new Error('server offline'));
  assert.equal(await newestSave, false);
  assert.equal(JSON.parse(session.get('ai-video-studio:unsaved:p1')).idea, 'newest draft');
  assert.match(vm.runInContext(`saveMessages.get('p1')`, context), /Belum tersimpan/);
});

test('failed save status survives wizard tab changes and rerendering', async () => {
  const { context, element, click } = appContext({ fetchImpl: async (url, options) => {
    if (options?.method === 'PUT') throw new Error('offline');
    return response([]);
  } });
  vm.runInContext(`current=${JSON.stringify(project())};activeTab='idea'`, context);
  await vm.runInContext('saveNow()', context);
  assert.match(vm.runInContext(`saveMessages.get('p1')`, context), /Belum tersimpan/);
  await click({ tab: 'storyboard' });
  assert.equal(vm.runInContext('activeTab', context), 'storyboard');
  assert.match(element('#save-state').textContent, /Belum tersimpan/);
  vm.runInContext('renderProject()', context);
  assert.match(element('#save-state').textContent, /Belum tersimpan/);
});

test('sessionStorage failure is reported as memory-only and blocks leaving the project', async () => {
  const { context, click, session, getScrolls } = appContext({
    fetchImpl: async (url, options) => {
      if (options?.method === 'PUT') throw new Error('offline');
      return response([]);
    },
    storageImpl: { setItem() { throw new Error('storage unavailable'); }, getItem() { throw new Error('storage unavailable'); }, removeItem() { throw new Error('storage unavailable'); } },
  });
  vm.runInContext(`projects=[${JSON.stringify(project())},${JSON.stringify(project('p2'))}];current=projects[0];current.idea='in-memory draft'`, context);
  await vm.runInContext('saveNow()', context);
  assert.match(vm.runInContext(`saveMessages.get('p1')`, context), /hanya ada di memori/);
  assert.equal(vm.runInContext('current.idea', context), 'in-memory draft');
  const before = getScrolls();
  await click({ open: 'p2' });
  assert.equal(vm.runInContext('current.id', context), 'p1');
  assert.equal(getScrolls(), before);
  await click({ view: 'projects' });
  assert.equal(vm.runInContext('current.id', context), 'p1');
  assert.equal(getScrolls(), before);
  assert.equal(session.size, 0);
});

test('a saved recovery draft is offered and restored when reopening its project', async () => {
  const saved = project();
  const draft = { ...saved, idea: 'recovered idea', data: { ...saved.data, scenes: [{ id: 's1', title: 'Draft scene' }] } };
  const { context, session, getConfirms } = appContext({ projects: [saved] });
  session.set('ai-video-studio:unsaved:p1', JSON.stringify(draft));
  vm.runInContext(`projects=[${JSON.stringify(saved)}]`, context);
  await vm.runInContext(`openProject('p1')`, context);
  assert.equal(vm.runInContext('current.idea', context), 'recovered idea');
  assert.equal(vm.runInContext('current.data.scenes[0].title', context), 'Draft scene');
  assert.match(vm.runInContext(`saveMessages.get('p1')`, context), /Draft dipulihkan/);
  assert.equal(getConfirms(), 1);
});

test('a failed-save draft survives asset upload and retry saves both the draft and new asset', async () => {
  let puts = 0;
  const sent = [];
  const uploaded = { id: 'asset-1', name: 'ref.png', url: '/uploads/ref.png', type: 'Karakter' };
  const { context, element, session, click } = appContext({ fetchImpl: async (url, options) => {
    if (options?.method === 'PUT') {
      puts++;
      sent.push(JSON.parse(options.body));
      if (puts === 1) throw new Error('offline');
      return response(JSON.parse(options.body));
    }
    if (options?.method === 'POST' && url.endsWith('/assets')) return response({ name: uploaded.name, url: uploaded.url, asset: uploaded });
    if (url === '/api/projects') return response([]);
    return response({});
  } });
  const draft = project();
  draft.idea = 'draft sebelum unggah';
  draft.data.scenes = [{ id: 's1', title: 'Adegan draft', action: 'Berjalan', assetIds: [] }];
  vm.runInContext(`current=${JSON.stringify(draft)};projects=[current];activeTab='assets'`, context);
  await vm.runInContext('saveNow()', context);
  assert.match(vm.runInContext(`saveMessages.get('p1')`, context), /Belum tersimpan/);

  element('#asset-type').value = 'Karakter';
  await vm.runInContext(`uploadAssets({target:{files:[{name:'ref.png',type:'image/png'}]}})`, context);
  assert.equal(vm.runInContext('current.idea', context), 'draft sebelum unggah');
  assert.equal(vm.runInContext('current.data.scenes[0].title', context), 'Adegan draft');
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(current.data.assets)', context)), [uploaded]);
  assert.match(vm.runInContext(`saveMessages.get('p1')`, context), /Belum tersimpan/);
  assert.deepEqual(JSON.parse(session.get('ai-video-studio:unsaved:p1')).data.assets, [uploaded]);

  await click({ id: 'retry-save' });
  assert.equal(sent[1].idea, 'draft sebelum unggah');
  assert.deepEqual(sent[1].data.assets, [uploaded]);
  assert.equal(session.has('ai-video-studio:unsaved:p1'), false);
});

test('an edit made after asset upload is included in the retry snapshot', async () => {
  let puts = 0;
  let secondBody;
  const uploaded = { id: 'asset-2', name: 'room.webp', url: '/uploads/room.webp', type: 'Lokasi' };
  const { context, element, click } = appContext({ fetchImpl: async (url, options) => {
    if (options?.method === 'PUT') {
      puts++;
      const body = JSON.parse(options.body);
      if (puts === 1) throw new Error('offline');
      secondBody = body;
      return response(body);
    }
    if (options?.method === 'POST' && url.endsWith('/assets')) return response({ asset: uploaded });
    return response([]);
  } });
  vm.runInContext(`current=${JSON.stringify(project())};projects=[current];activeTab='assets'`, context);
  await vm.runInContext('saveNow()', context);
  element('#asset-type').value = 'Lokasi';
  await vm.runInContext(`uploadAssets({target:{files:[{name:'room.webp',type:'image/webp'}]}})`, context);
  vm.runInContext(`current.idea='edit setelah upload';scheduleSave()`, context);
  await click({ id: 'retry-save' });
  assert.equal(secondBody.idea, 'edit setelah upload');
  assert.deepEqual(secondBody.data.assets, [uploaded]);
});

test('a normal asset upload updates project assets without reloading and preserves saved status', async () => {
  let projectListRequests = 0;
  const uploaded = { id: 'asset-3', name: 'product.gif', url: '/uploads/product.gif', type: 'Produk' };
  const { context, element } = appContext({ fetchImpl: async (url, options) => {
    if (url === '/api/projects') { projectListRequests++; return response([]); }
    if (options?.method === 'POST' && url.endsWith('/assets')) return response({ asset: uploaded });
    return response({});
  } });
  vm.runInContext(`current=${JSON.stringify(project())};projects=[current];activeTab='assets';saveMessages.set('p1','Perubahan tersimpan')`, context);
  await tick();
  const initialListRequests = projectListRequests;
  element('#asset-type').value = 'Produk';
  await vm.runInContext(`uploadAssets({target:{files:[{name:'product.gif',type:'image/gif'}]}})`, context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(current.data.assets)', context)), [uploaded]);
  assert.equal(projectListRequests, initialListRequests);
  assert.equal(vm.runInContext(`saveMessages.get('p1')`, context), 'Perubahan tersimpan');
});

test('a failed sessionStorage removal does not offer an identical server-saved backup', async () => {
  const session = new Map();
  const savedStorage = {
    setItem: (key, value) => session.set(key, value),
    getItem: key => session.get(key) ?? null,
    removeItem() { throw new Error('remove denied'); },
  };
  const { context, getConfirms } = appContext({
    storageImpl: savedStorage,
    confirmImpl: () => true,
    fetchImpl: async (url, options) => {
      if (options?.method === 'PUT') return response({ ...JSON.parse(options.body), updated_at: 'server timestamp' });
      if (url === '/api/projects') return response([]);
      return response({});
    },
  });
  vm.runInContext(`current=${JSON.stringify(project())};projects=[current]`, context);
  assert.equal(await vm.runInContext('saveNow()', context), true);
  assert.ok(session.has('ai-video-studio:unsaved:p1'));
  await vm.runInContext(`openProject('p1')`, context);
  assert.equal(getConfirms(), 0);
  assert.equal(vm.runInContext('current.idea', context), '');
});

test('retry button saves the newest draft and clears its backup', async () => {
  let puts = 0;
  const { context, click, session, element } = appContext({ fetchImpl: async (url, options) => {
    if (options?.method === 'PUT') {
      puts++;
      if (puts === 1) throw new Error('offline');
      return response(JSON.parse(options.body));
    }
    return response([]);
  } });
  vm.runInContext(`current=${JSON.stringify(project())};current.idea='retry this'`, context);
  await vm.runInContext('saveNow()', context);
  assert.ok(session.has('ai-video-studio:unsaved:p1'));
  await click({ id: 'retry-save' });
  assert.equal(puts, 2);
  assert.equal(session.has('ai-video-studio:unsaved:p1'), false);
  assert.equal(vm.runInContext(`saveMessages.get('p1')`, context), 'Perubahan tersimpan');
  assert.equal(element('#save-state').textContent, 'Perubahan tersimpan');
});

test('manual storyboard generation does not advance when its save fails', async () => {
  const { context, element, session } = appContext({ fetchImpl: async (url, options) => {
    if (options?.method === 'PUT') throw new Error('offline');
    return response([]);
  } });
  element('#idea-input').value = 'Seseorang menanam pohon.';
  element('#duration-input').value = '30 detik';
  element('#style-input').value = 'Hangat';
  vm.runInContext(`current=${JSON.stringify(project())};activeTab='idea'`, context);
  await vm.runInContext('draftStory()', context);
  assert.equal(vm.runInContext('activeTab', context), 'idea');
  assert.equal(vm.runInContext('current.data.scenes.length', context), 3);
  assert.equal(JSON.parse(session.get('ai-video-studio:unsaved:p1')).idea, 'Seseorang menanam pohon.');
  assert.match(element('#save-state').textContent, /Belum tersimpan — penyimpanan gagal/);
  assert.equal(element('#toast').textContent, '', 'the failure is shown in the save status, not a toast over the cards');
});

test('prompt text and copied JSON use the same effective camera and lighting values', () => {
  const { context } = appContext();
  context.testScene = { id: 's1', title: 'Pembuka', camera: '', lighting: '', assetIds: [] };
  context.testData = { assets: [] };
  const result = vm.runInContext(`({prompt:makePrompt(testScene,platforms.flow,testData),json:promptExport({title:'Demo'},platforms.flow,testScene,[])})`, context);
  assert.equal(result.json.scene.camera, 'medium shot, gerakan kamera lembut');
  assert.equal(result.json.scene.lighting, 'pencahayaan lembut sesuai suasana adegan');
  assert.ok(result.prompt.includes(`Framing dan kamera: ${result.json.scene.camera}.`));
  assert.ok(result.prompt.includes(`Pencahayaan: ${result.json.scene.lighting}.`));
});

test('legacy project data normalizes without dropping fields or asset links', () => {
  const { context } = appContext();
  context.legacyProject = {
    id: 'old', title: 'Proyek lama', goal: 'Cerita', idea: 'Ide lama', platform: 'flow',
    data: { style: 'Natural', character: 'Ayah berbaju biru', customNote: 'tetap ada',
      assets: [{ id: 'asset-1', name: 'ayah.png', url: '/uploads/ayah.png' }],
      scenes: [{ id: 'scene-1', purpose: 'Bertemu', visual: 'Ayah membuka pintu', assetIds: ['asset-1'] }] },
  };
  const result = vm.runInContext(`normalizeProductionData(legacyProject.data,legacyProject)`, context);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.projectBrief.idea, 'Ide lama');
  assert.equal(result.projectBrief.characterNotes, 'Ayah berbaju biru');
  assert.equal(result.customNote, 'tetap ada');
  assert.equal(result.scenes[0].narrativePurpose, 'Bertemu');
  assert.equal(result.scenes[0].visualDescription, 'Ayah membuka pintu');
  assert.deepEqual(JSON.parse(JSON.stringify(result.scenes[0].referenceAssetIds)), ['asset-1']);
  assert.equal(result.assets[0].id, 'asset-1');
});

test('production prompt and JSON share canonical brief, scene, entities, duration, and linked assets', () => {
  const { context } = appContext();
  context.prodProject = {
    id: 'p1', title: 'Pagi', goal: 'Promosi', idea: 'Kopi pagi', platform: 'flow',
    data: {
      schemaVersion: 1,
      projectBrief: { idea: 'Kopi pagi', videoType: 'Promosi', visualStyle: 'Hangat', targetDuration: '8 detik', keyMessage: 'Mulai tenang' },
      storyPlan: { title: 'Pagi baru' },
      entities: { characters: [{ id: 'c1', name: 'Barista', appearance: 'apron hijau' }], products: [{ id: 'pr1', name: 'Kopi' }], locations: [{ id: 'l1', name: 'Kedai' }] },
      assets: [{ id: 'a1', name: 'kedai.png', url: '/uploads/kedai.png', type: 'Lokasi' }],
      scenes: [], checks: {}, productionSettings: { platform: 'flow', aspectRatio: '16:9' },
    },
  };
  context.prodScene = { id: 's1', title: 'Menyeduh', purpose: 'Tampilkan proses', visual: 'Uap di cangkir', action: 'Barista menuang', characterIds: ['c1'], productIds: ['pr1'], locationId: 'l1', assetIds: ['a1'], camera: '', lighting: '', duration: '8 detik', audio: { voiceover: 'Pagi dimulai', music: 'piano lembut', effects: [] }, continuityIn: { position: 'dekat meja' }, continuityOut: { position: 'mengangkat cangkir' } };
  context.prodProject.data.scenes.push(context.prodScene);
  const result = vm.runInContext(`(()=>{const platform=platforms.flow;const prompt=makePrompt(prodScene,platform,prodProject.data,prodProject);const json=promptExport(prodProject,platform,prodScene,undefined,prompt);return{prompt,json}})()`, context);
  assert.equal(result.json.schemaVersion, 1);
  assert.equal(result.json.scene.camera, 'medium shot, gerakan kamera lembut');
  assert.equal(result.json.scene.lighting, 'pencahayaan lembut sesuai suasana adegan');
  assert.equal(result.json.scene.duration, '8 detik');
  assert.equal(result.json.selectedAssets[0].id, 'a1');
  assert.equal(result.json.characters[0].name, 'Barista');
  assert.equal(result.json.products[0].name, 'Kopi');
  assert.equal(result.json.location.name, 'Kedai');
  assert.equal(result.json.prompt, result.prompt);
  assert.equal(result.json.durationSummary.projectTarget, '8 detik');
  assert.equal(result.json.durationSummary.sceneTotalSeconds, 8);
  assert.ok(result.prompt.includes('Rencana video: target proyek 8 detik; total durasi scene 8 detik.'));
  for (const text of ['Pagi baru', 'Barista', 'Kopi', 'Kedai', 'kedai.png', '8 detik', result.json.scene.camera, result.json.scene.lighting]) assert.ok(result.prompt.includes(text));
});

test('editing one scene and synchronizing production fields preserves other scenes', () => {
  const { context } = appContext();
  context.twoSceneProject = project();
  context.twoSceneProject.data.scenes = [
    { id: 's1', purpose: 'Awal', visual: 'Pintu tertutup', action: 'Menunggu', assetIds: ['a1'] },
    { id: 's2', purpose: 'Akhir', visual: 'Pintu terbuka', action: 'Masuk', assetIds: ['a2'], continuityIn: { door: 'terbuka' } },
  ];
  const result = vm.runInContext(`(()=>{const p=twoSceneProject;syncProjectData(p);const second=JSON.stringify(p.data.scenes[1]);p.data.scenes[0].visual='Hujan di pintu';p.data.scenes[0].visualDescription='Hujan di pintu';syncProjectData(p);return{second,after:JSON.stringify(p.data.scenes[1]),first:p.data.scenes[0]}})()`, context);
  assert.equal(result.after, result.second);
  assert.equal(result.first.visualDescription, 'Hujan di pintu');
  assert.deepEqual(JSON.parse(JSON.stringify(result.first.referenceAssetIds)), ['a1']);
  assert.deepEqual(JSON.parse(JSON.stringify(result.after && JSON.parse(result.after).referenceAssetIds)), ['a2']);
});

test('asset linking follows explicit one, many, and all scene choices with synchronized ids', async () => {
  const { context, click } = appContext();
  context.linkData = { assets: [{ id: 'a1', name: 'ref.png' }], checks: {}, scenes: [
    { id: 's1', assetIds: [], referenceAssetIds: [] },
    { id: 's2', assetIds: [], referenceAssetIds: [] },
    { id: 's3', assetIds: [], referenceAssetIds: [] },
  ] };
  vm.runInContext(`linkAssetToScenes(linkData,'a1',['s1'])`, context);
  assert.deepEqual(JSON.parse(vm.runInContext(`JSON.stringify(linkData.scenes.map(s=>s.assetIds))`, context)), [['a1'], [], []]);
  vm.runInContext(`linkAssetToScenes(linkData,'a1',['s1','s2'])`, context);
  assert.deepEqual(JSON.parse(vm.runInContext(`JSON.stringify(linkData.scenes.map(s=>s.referenceAssetIds))`, context)), [['a1'], ['a1'], []]);
  vm.runInContext(`current=${JSON.stringify(project())};current.data=linkData;activeTab='assets'`, context);
  await click({ linkAll: 'a1' });
  assert.deepEqual(JSON.parse(vm.runInContext(`JSON.stringify(current.data.scenes.map(s=>[s.assetIds,s.referenceAssetIds]))`, context)), [[['a1'], ['a1']], [['a1'], ['a1']], [['a1'], ['a1']]]);
});

test('project target duration overrides stale legacy value and six ten-second scenes total one minute', () => {
  const { context } = appContext();
  context.durationData = {
    duration: '1 menit', projectBrief: { targetDuration: '30 detik' }, assets: [], checks: {},
    scenes: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, duration: '10 detik', assetIds: [] })),
  };
  const result = vm.runInContext(`(()=>{const d=normalizeProductionData(durationData,{platform:'flow'});return{target:d.projectBrief.targetDuration,plan:durationPlan(d)}})()`, context);
  assert.equal(result.target, '1 menit');
  assert.equal(result.plan.targetSeconds, 60);
  assert.equal(result.plan.sceneTotalSeconds, 60);
  assert.equal(result.plan.matches, true);
  assert.equal(result.plan.providerClipLimitSeconds, null);
});

test('prompt removes repeated punctuation and duplicate scene location/time values', () => {
  const { context } = appContext();
  context.promptProject = {
    id: 'p1', title: 'Kedai', platform: 'flow', idea: '', goal: 'Cerita',
    data: { projectBrief: { targetDuration: '10 detik', locationNotes: 'Kedai' }, storyPlan: {}, assets: [], checks: {},
      entities: { characters: [], products: [], locations: [{ id: 'l1', name: 'Kedai' }] }, scenes: [] },
  };
  context.promptScene = { id: 's1', title: 'Pagi..', location: 'Kedai', time: 'Pagi', locationId: 'l1', action: 'Membuka pintu..', duration: '10 detik', assetIds: [] };
  context.promptProject.data.scenes.push(context.promptScene);
  const prompt = vm.runInContext(`makePrompt(promptScene,platforms.flow,promptProject.data,promptProject)`, context);
  assert.ok(prompt.includes('Adegan: Pagi.'));
  assert.ok(prompt.includes('Aksi: Membuka pintu.'));
  assert.ok(prompt.includes('Lokasi dan waktu: Kedai, Pagi.'));
  assert.equal((prompt.match(/Lokasi dan waktu:/g) || []).length, 1);
  assert.equal(prompt.includes('..'), false);
});

test('asset page direct deletion confirms affected scenes and updates UI project data', async () => {
  const source = project();
  source.data.assets = [{ id: 'a1', name: 'ayah.png', url: '/uploads/ayah.png' }];
  source.data.scenes = [{ id: 's1', title: 'Ayah masuk', assetIds: ['a1'], referenceAssetIds: ['a1'], productionChecklist: { assets: true } }];
  const updated = JSON.parse(JSON.stringify(source));
  updated.data.assets = [];
  updated.data.scenes[0].assetIds = [];
  updated.data.scenes[0].referenceAssetIds = [];
  updated.data.scenes[0].productionChecklist.assets = false;
  const { context, click, confirmMessages } = appContext({ fetchImpl: async (url, options) => {
    if (options?.method === 'DELETE') return response({ assetId: 'a1', project: updated });
    if (options?.method === 'PUT') return response(JSON.parse(options.body));
    return response([]);
  } });
  vm.runInContext(`current=${JSON.stringify(source)};projects=[current];activeTab='assets'`, context);
  await click({ deleteAsset: 'a1' });
  assert.match(confirmMessages[0], /Ayah masuk/);
  assert.deepEqual(JSON.parse(vm.runInContext(`JSON.stringify(current.data.assets)`, context)), []);
  assert.deepEqual(JSON.parse(vm.runInContext(`JSON.stringify(current.data.scenes[0].referenceAssetIds)`, context)), []);
  assert.equal(vm.runInContext(`saveMessages.get('p1')`, context), 'Perubahan tersimpan');
});

test('checklist and production JSON preserve actual per-scene checkbox status', () => {
  const { context } = appContext();
  context.checkProject = project();
  context.checkProject.data.scenes = [{ id: 's1', title: 'Awal', assetIds: [], productionChecklist: { assets: true, prompt: true, generated: false, collected: false } }];
  const result = vm.runInContext(`(()=>{const p=checkProject,s=p.data.scenes[0];syncProjectData(p);return promptExport(p,platforms.flow,s,[]).scene.productionChecklist})()`, context);
  assert.equal(result.assets, true);
  assert.equal(result.prompt, true);
  assert.equal(result.generated, false);
  assert.equal(result.collected, false);
});

test('changing a checklist control updates only its scene and legacy JSON check key', () => {
  const { context } = appContext();
  context.checkData = { checks: {}, scenes: [
    { id: 'first', productionChecklist: { assets: false, prompt: false, generated: false, collected: false } },
    { id: 'second', productionChecklist: { assets: false, prompt: false, generated: false, collected: false } },
  ] };
  const result = vm.runInContext(`(()=>{const selected=updateSceneChecklist(checkData,'scene-second-generated',true);return{selected:selected.id,checks:checkData.checks,first:checkData.scenes[0].productionChecklist,second:checkData.scenes[1].productionChecklist}})()`, context);
  assert.equal(result.selected, 'second');
  assert.equal(result.checks['scene-second-generated'], true);
  assert.equal(result.first.generated, false);
  assert.equal(result.second.generated, true);
  assert.equal(result.second.collected, false);
});

test('Gemini provider is sent explicitly and draft stays unapplied until user confirmation', async () => {
  const calls = [];
  let approve = false;
  const existing = project();
  existing.idea = 'Cerita lama';
  existing.data.entities = { characters: [], locations: [], products: [] };
  existing.data.scenes = [{ id: 'old-scene', title: 'Adegan lama' }];
  const { context, element } = appContext({
    confirmImpl: () => approve,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/ai/story') return response({ draft: { alternatives: [{
        title: 'Cerita Gemini', logline: 'Arah cerita baru', message: 'Pesan baru',
        scenes: [{ id: 'new-scene', title: 'Adegan baru', visual: 'Hujan reda' }],
      }] } });
      if (options?.method === 'PUT') return response(JSON.parse(options.body));
      if (url === '/api/projects') return response([]);
      return response({});
    },
  });
  vm.runInContext(`current=${JSON.stringify(existing)};projects=[current];activeTab='idea'`, context);
  element('#ai-provider').value = 'gemini';
  element('#idea-input').value = 'Seseorang menemukan rumah setelah hujan';
  element('#duration-input').value = '30 detik';
  element('#style-input').value = 'Sinematik natural';

  await vm.runInContext('requestAIDraft()', context);
  const request = calls.find(call => call.url === '/api/ai/story');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.provider, 'gemini');
  assert.equal(payload.idea, 'Seseorang menemukan rumah setelah hujan');
  assert.equal('model' in payload, false);
  assert.match(element('#ai-review-source').textContent, /GEMINI/);
  assert.equal(vm.runInContext('current.data.scenes[0].id', context), 'old-scene');

  await element('#apply-ai-draft').onclick();
  assert.equal(calls.some(call => call.options?.method === 'PUT'), false);
  assert.equal(vm.runInContext('current.data.scenes[0].id', context), 'old-scene');
  assert.equal(vm.runInContext('activeTab', context), 'idea');

  approve = true;
  await element('#apply-ai-draft').onclick();
  const save = calls.find(call => call.options?.method === 'PUT');
  assert.ok(save, 'confirmed draft should be saved');
  assert.equal(JSON.parse(save.options.body).data.scenes[0].id, 'new-scene');
  assert.equal(vm.runInContext('current.data.scenes[0].id', context), 'new-scene');
  assert.equal(vm.runInContext('activeTab', context), 'storyboard');
  assert.match(element('#toast').textContent, /Gemini/);
});

test('characters and locations get stable ids and manual entries survive a draft apply', async () => {
  const { context } = appContext();
  vm.runInContext(`current=${JSON.stringify(project('p1'))};current.data=normalizeProductionData({characters:[{name:'Lama',appearance:'x'}],locations:[{name:'Pasar'}]},current);`, context);
  const firstIds = vm.runInContext('current.data.entities.characters.map(c=>c.id)', context);
  assert.ok(firstIds[0].startsWith('char-'));
  vm.runInContext('normalizeProductionData(current.data,current)', context);
  assert.deepEqual(vm.runInContext('current.data.entities.characters.map(c=>c.id)', context), firstIds);
  vm.runInContext(`current.data.entities.characters.push({id:'char-manual',name:'Rani',role:'tokoh utama',appearance:'ikal',source:'manual'});current.data.entities.locations.push({id:'loc-manual',name:'Kedai',description:'hangat',source:'manual'});aiDraft={alternatives:[{title:'Baru',characters:[{name:'Budi',appearance:'topi'}],locations:[{name:'Stasiun',description:'ramai'}],scenes:[{id:'x',title:'Awal',visual:'v'}]}]};aiDraftProvider='ollama';`, context);
  await vm.runInContext('applyAIDraft()', context);
  const names = vm.runInContext('current.data.entities.characters.map(c=>c.name)', context);
  assert.deepEqual(names.sort(), ['Budi', 'Rani']);
  assert.equal(vm.runInContext("current.data.entities.characters.find(c=>c.name==='Rani').id", context), 'char-manual');
  assert.equal(vm.runInContext("current.data.entities.characters.find(c=>c.name==='Budi').source", context), 'ai');
  assert.deepEqual(vm.runInContext('current.data.entities.locations.map(l=>l.name).sort()', context), ['Kedai', 'Stasiun']);
});

const linkedData = () => ({
  projectBrief: {}, storyPlan: {}, assets: [], checks: {},
  entities: {
    characters: [{ id: 'char-a', name: 'Rani', role: 'tokoh utama', appearance: 'rambut ikal' }, { id: 'char-b', name: 'Budi', appearance: 'topi merah' }],
    products: [],
    locations: [{ id: 'loc-a', name: 'Kedai', description: 'lampu kuning' }, { id: 'loc-b', name: 'Pasar', description: 'ramai' }],
  },
  scenes: [
    { id: 's1', title: 'Satu', action: 'Rani masuk', characterIds: ['char-a'], locationId: 'loc-a' },
    { id: 's2', title: 'Dua', action: 'Budi keluar', characterIds: ['char-b'], locationId: '' },
    { id: 's3', title: 'Tiga', action: 'Tanpa pilihan', characterIds: [], locationId: '' },
  ],
});

test('selected character and location descriptions reach only the scene that uses them', () => {
  const { context } = appContext();
  context.linkedProject = { id: 'p1', title: 'Kopi', goal: 'Promosi', idea: '', platform: 'flow', data: linkedData() };
  const out = vm.runInContext(`(()=>{const d=linkedProject.data,p=linkedProject,pl=platforms.flow;return{one:makePrompt(d.scenes[0],pl,d,p),two:makePrompt(d.scenes[1],pl,d,p),three:makePrompt(d.scenes[2],pl,d,p)}})()`, context);
  assert.ok(out.one.includes('Rani (tokoh utama): rambut ikal'));
  assert.ok(out.one.includes('Kedai: lampu kuning'));
  assert.equal(out.one.includes('Budi'), false);
  assert.equal(out.one.includes('Pasar'), false);
  assert.ok(out.two.includes('Budi: topi merah'));
  assert.equal(out.two.includes('Rani'), false);
  assert.equal(out.two.includes('Kedai'), false);
  assert.equal(out.three.includes('Karakter yang harus dipertahankan'), false);
  assert.equal(out.three.includes('Lokasi yang harus dipertahankan'), false);
});

test('toggling scene links adds and removes ids without duplicates', () => {
  const { context } = appContext();
  const s = { id: 's1', characterIds: ['char-a'], locationId: '' };
  vm.runInContext('setSceneEntity(scene,"characters","char-b",true);setSceneEntity(scene,"characters","char-b",true);setSceneEntity(scene,"characters","char-a",false);setSceneEntity(scene,"locations","loc-a",true)', Object.assign(context, { scene: s }));
  assert.deepEqual(JSON.parse(JSON.stringify(s.characterIds)), ['char-b']);
  assert.equal(s.locationId, 'loc-a');
  vm.runInContext('setSceneEntity(scene,"locations","",true)', Object.assign(context, { scene: s }));
  assert.equal(s.locationId, '');
});

test('removing a character or location clears only its references', () => {
  const { context } = appContext();
  context.removeProject = { data: linkedData() };
  vm.runInContext('removeEntity(removeProject.data,"characters","char-a");removeEntity(removeProject.data,"locations","loc-a")', context);
  const d = context.removeProject.data;
  assert.deepEqual(d.scenes[0].characterIds, []);
  assert.equal(d.scenes[0].locationId, '');
  assert.deepEqual(d.scenes[1].characterIds, ['char-b']);
  assert.deepEqual(d.entities.characters.map(c => c.id), ['char-b']);
  assert.deepEqual(d.characters.map(c => c.id), ['char-b']);
  assert.deepEqual(d.entities.locations.map(l => l.id), ['loc-b']);
});

test('links survive save and reopen and dangling references are pruned on load', () => {
  const { context } = appContext();
  const data = linkedData();
  data.scenes[0].characterIds.push('char-missing');
  data.scenes[0].locationId = 'loc-missing';
  context.reopenProject = { id: 'p1', title: 'Kopi', goal: 'Promosi', idea: '', platform: 'flow', data: JSON.parse(JSON.stringify(data)) };
  const reopened = vm.runInContext('normalizeProductionData(JSON.parse(JSON.stringify(reopenProject.data)),reopenProject).scenes', context);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened[0].characterIds)), ['char-a']);
  assert.equal(reopened[0].locationId, '');
  assert.deepEqual(JSON.parse(JSON.stringify(reopened[1].characterIds)), ['char-b']);
});

test('legacy project without character or location data opens and prompts as before', () => {
  const { context } = appContext();
  context.legacyProject = { id: 'p9', title: 'Lama', goal: 'Cerita', idea: '', platform: 'flow', data: { scenes: [{ id: 'old', title: 'Lama', action: 'Berjalan' }] } };
  const result = vm.runInContext('(()=>{const d=normalizeProductionData(legacyProject.data,legacyProject);return{chars:d.entities.characters,locs:d.entities.locations,prompt:makePrompt(d.scenes[0],platforms.flow,d,legacyProject)}})()', context);
  assert.deepEqual(JSON.parse(JSON.stringify(result.chars)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(result.locs)), []);
  assert.equal(result.prompt.includes('Karakter yang harus dipertahankan'), false);
  assert.equal(result.prompt.includes('Lokasi yang harus dipertahankan'), false);
  assert.ok(result.prompt.includes('Aksi: Berjalan.'));
});

test('autosave keeps the live project data object so writes made through an earlier render are saved', async () => {
  const calls = [];
  const { context } = appContext({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options?.method === 'PUT') return response(JSON.parse(options.body));
      if (url === '/api/projects') return response([]);
      return response({});
    },
  });
  await tick();
  vm.runInContext(`current=${JSON.stringify(project('p1'))};current.data=normalizeProductionData(current.data,current);current.data.scenes=[{id:'s1',title:'Satu'},{id:'s2',title:'Dua'}];projects=[current]`, context);
  context.renderedData = vm.runInContext('current.data', context);
  await vm.runInContext("current.data.scenes[0].title='Satu baru';saveNow()", context);
  assert.equal(vm.runInContext('current.data === renderedData', context), true, 'autosave must not replace the data object used by open handlers');
  context.renderedData.promptScene = 1;
  await vm.runInContext('saveNow()', context);
  const put = calls.filter(call => call.options?.method === 'PUT').at(-1);
  assert.equal(JSON.parse(put.options.body).data.promptScene, 1);
  assert.equal(vm.runInContext('current.data.promptScene', context), 1);
});

// Production package (B2): UI behaviour on top of the B1 endpoints. Gemini is always mocked.
const samplePackage = () => ({
  model: 'flow-default', concept: 'Kopi pagi dalam dua klip.', total_seconds: 15,
  warnings: ['Batas 10 detik untuk Google Flow (konfigurasi awal) belum diverifikasi.'],
  characters: [{ id: 'char-barista', name: 'Rani', role: 'barista', appearance: 'celemek hijau' }],
  products: [{ id: 'prod-kopi', name: 'Kopi kemasan' }],
  locations: [{ id: 'loc-kedai', name: 'Kedai', description: 'kayu hangat' }],
  image_requirements: [{ id: 'img-rani', purpose: 'karakter', subject: 'char-barista', description: 'wajah Rani', generation: 'manual', asset_id: null, status: 'needed' }],
  clips: [
    { index: 1, duration_seconds: 6, prompt_final: 'Close-up kemasan kopi di meja kayu.', prompt_en: 'Close-up of a coffee pack on a wooden table.', en: { action: 'Hands open the pack', camera: 'close-up', lighting: 'morning light', audio_text: 'soft music' }, action: 'Tangan membuka kemasan', camera: 'close-up', lighting: 'cahaya pagi', references: [{ kind: 'requirement', id: 'img-rani', role: 'karakter' }], characters: ['char-barista'], locations: ['loc-kedai'], audio: { plan: 'musik', text: '', note: 'musik lembut' }, continues_from: null },
    { index: 2, duration_seconds: 9, prompt_final: 'Tangan menuang kopi, uap naik.', prompt_en: 'Hands pour coffee, steam rises.', en: { action: 'Pouring', camera: 'medium shot', lighting: 'warm light', audio_text: '' }, action: 'Menuang', camera: 'medium shot', lighting: 'hangat', references: [{ kind: 'asset', id: 'a-produk', role: 'produk' }], characters: [], locations: [], audio: { plan: 'efek', text: '', note: '' }, continues_from: 1 },
  ],
  upload_checklist: [
    { order: 1, kind: 'requirement', id: 'img-rani', name: 'karakter', role: 'karakter', first_clip: 1, status: 'needed' },
    { order: 2, kind: 'asset', id: 'a-produk', name: 'kopi-kemasan.png', role: 'produk', first_clip: 2, status: 'uploaded' },
  ],
});
const savedView = pkg => ({ schemaVersion: 1, savedAt: '2026-10-17T00:00:00+00:00', targetSeconds: 15, package: pkg, error: null });
const confirmedUnderstanding = () => ({
  status: 'confirmed', ideaAtConfirm: 'Kopi pagi', core: 'Kopi pagi yang hangat.', message: '',
  characters: [], locations: [], sequence: [], unclear: [], suggestions: [],
});
function packageProject(view, understanding = confirmedUnderstanding()) {
  const p = project('p1');
  p.idea = 'Kopi pagi';
  p.data.duration = '30 detik';
  p.data.assets = [{ id: 'a-produk', name: 'kopi-kemasan.png', type: 'Produk', url: '/uploads/a.png' }];
  if (understanding) p.data.understanding = understanding;
  if (view) p.data.productionPackage = view;
  return p;
}
const openPackageTab = (context, p) => vm.runInContext(`current=${JSON.stringify(p)};projects=[current];activeTab='package';renderProject()`, context);
const openIdeaTab = (context, p) => vm.runInContext(`current=${JSON.stringify(p)};projects=[current];activeTab='idea';renderProject()`, context);

test('package tab enables Gemini generation only when the server reports a key', async () => {
  let configured = false;
  const { context, element } = appContext({
    fetchImpl: async url => (url === '/api/ai/gemini/status' ? response({ configured, source: null }) : response({})),
  });
  openPackageTab(context, packageProject());
  await tick();
  assert.equal(element('#build-package').disabled, true);
  assert.match(element('#package-status').textContent, /GEMINI_API_KEY belum terbaca/);
  configured = true;
  await vm.runInContext('refreshPackageProvider()', context);
  assert.equal(element('#build-package').disabled, false);
});

test('building a package sends only the idea and project id, shows a review, and saves nothing until confirmed', async () => {
  const calls = [];
  const pkg = samplePackage();
  const { context, element, click } = appContext({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/ai/gemini/status') return response({ configured: true });
      if (url === '/api/ai/production') return response({ package: pkg });
      if (url.endsWith('/production-package')) return response({ ...project('p1'), data: { ...project('p1').data, productionPackage: savedView(JSON.parse(options.body).package) } });
      return response(url === "/api/projects" ? [] : {});
    },
  });
  openPackageTab(context, packageProject());
  await tick();
  await click({ id: 'build-package' });
  const body = JSON.parse(calls.find(call => call.url === '/api/ai/production').options.body);
  assert.equal(body.project_id, 'p1');
  assert.equal(body.idea, 'Kopi pagi');
  assert.equal(body.include_images, false);
  assert.equal(body.model_key, 'flow-default');
  assert.equal(calls.some(call => call.options?.method === 'PUT'), false, 'nothing is saved before confirmation');
  assert.match(element('#tab-content').innerHTML, /Tinjau paket sebelum disimpan/);

  await click({ id: 'save-package' });
  const saves = calls.filter(call => call.options?.method === 'PUT');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].url, '/api/projects/p1/production-package');
  const saveBody = JSON.parse(saves[0].options.body);
  assert.equal(saveBody.targetSeconds, 30);
  assert.equal(saveBody.package.concept, pkg.concept);
  assert.equal(calls.some(call => call.url === '/api/projects/p1' && call.options?.method === 'PUT'), false, 'the project data endpoint is not used for the package');
  assert.equal(vm.runInContext('packageDraft', context), null);
  assert.equal(vm.runInContext('current.data.productionPackage.package.concept', context), pkg.concept);
  assert.match(element('#tab-content').innerHTML, /TERSIMPAN DI PROYEK INI/);
});

test('a saved package reopens after reload with clips, camera, lighting, audio, references, and upload status', async () => {
  const serverProject = packageProject(savedView(samplePackage()));
  const { context, element } = appContext({ projects: [serverProject] });
  await tick();
  vm.runInContext("openProject('p1')", context);
  vm.runInContext("setTab('package')", context);
  const html = element('#tab-content').innerHTML;
  for (const text of ['Klip 1', 'Klip 2', 'close-up', 'medium shot', 'cahaya pagi', 'Musik', 'Efek suara', 'Rani', 'Kopi kemasan', 'lanjutan dari klip 1', 'kebutuhan "karakter"', 'kopi-kemasan.png', 'Perlu diunggah', 'Sudah diunggah', 'Salin prompt Indonesia · klip 2', 'Salin prompt Inggris · klip 2']) {
    assert.ok(html.includes(text), `missing: ${text}`);
  }
  assert.ok(html.includes('data-copy-clip="2"'));
  assert.ok(html.includes('Batas 10 detik'), 'unverified model warning stays visible');
  assert.equal(html.includes('Gambar tidak ditemukan'), false);
});

test('copy button copies the clip prompt in the chosen language with its structured details', async () => {
  const copied = [];
  const { context, element, click } = appContext({ clipboardImpl: async text => { copied.push(text); } });
  openPackageTab(context, packageProject(savedView(samplePackage())));
  await tick();
  await click({ copyClip: '2', copyLang: 'id' });
  await tick();
  assert.ok(copied[0].startsWith('Tangan menuang kopi, uap naik.'));
  assert.ok(copied[0].includes('Detail produksi:'));
  assert.ok(copied[0].includes('- Kamera: medium shot'));
  assert.ok(copied[0].includes('- Pencahayaan: hangat'));
  assert.ok(copied[0].includes('lanjutan dari klip 1'));
  await click({ copyClip: '2', copyLang: 'en' });
  await tick();
  assert.ok(copied[1].startsWith('Hands pour coffee, steam rises.'));
  assert.ok(copied[1].includes('Production details:'));
  assert.ok(copied[1].includes('- Camera: medium shot'));
  assert.ok(copied[1].includes('- Lighting: warm light'));
  assert.match(element('#toast').textContent, /Tersalin/);
});

test('copied prompts keep every labelled detail line even when the base prompt already contains the same words', async () => {
  const copied = [];
  const { context, click } = appContext({ clipboardImpl: async text => { copied.push(text); } });
  const pkg = samplePackage();
  const clip = pkg.clips[1];
  clip.prompt_final = 'Rani duduk, kamera medium shot, cahaya hangat.';
  clip.prompt_en = 'Rani sits, medium shot, warm light.';
  clip.camera = 'medium shot';
  clip.lighting = 'cahaya hangat';
  clip.en = { ...clip.en, camera: 'medium shot', lighting: 'warm light' };
  openPackageTab(context, packageProject(savedView(pkg)));
  await tick();
  await click({ copyClip: '2', copyLang: 'id' });
  await tick();
  assert.ok(copied[0].includes('- Kamera: medium shot'), 'the camera line is not dropped');
  assert.ok(copied[0].includes('- Pencahayaan: cahaya hangat'), 'the lighting line is not dropped');
  await click({ copyClip: '2', copyLang: 'en' });
  await tick();
  assert.ok(copied[1].includes('- Camera: medium shot'), 'the English camera line is not dropped');
  assert.ok(copied[1].includes('- Lighting: warm light'), 'the English lighting line is not dropped');
});

test('an invalid stored package shows a clear warning and offers only removal', async () => {
  const stored = { schemaVersion: 1, savedAt: null, targetSeconds: null, package: null, error: 'Paket tersimpan tidak lolos validasi: Klip 1 berdurasi 15 detik, melebihi batas 10 detik. Data tersimpan tidak diubah.' };
  const { context, element } = appContext();
  openPackageTab(context, packageProject(stored));
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /Paket tersimpan tidak bisa dipakai/);
  assert.ok(html.includes('melebihi batas 10 detik'));
  assert.ok(html.includes('id="clear-package"'));
  assert.equal(html.includes('PROMPT FINAL'), false);
  assert.equal(html.includes('Salin prompt klip'), false);
});

test('choosing an image for a requirement saves only the package and marks it uploaded', async () => {
  const calls = [];
  const { context, element, change } = appContext({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/production-package')) return response({ ...project('p1'), data: { ...project('p1').data, productionPackage: savedView(JSON.parse(options.body).package) } });
      return response(url === "/api/projects" ? [] : {});
    },
  });
  openPackageTab(context, packageProject(savedView(samplePackage())));
  await tick();
  assert.ok(element('#tab-content').innerHTML.includes('<option value="a-produk"'));
  await change({ dataset: { linkRequirement: 'img-rani' }, value: 'a-produk' });
  await tick();
  await tick();
  const save = calls.find(call => call.options?.method === 'PUT');
  assert.equal(save.url, '/api/projects/p1/production-package');
  const linked = JSON.parse(save.options.body).package.image_requirements[0];
  assert.equal(linked.asset_id, 'a-produk');
  assert.equal(linked.status, 'uploaded');
  assert.equal(calls.some(call => call.url === '/api/projects/p1' && call.options?.method === 'PUT'), false);
  assert.match(element('#tab-content').innerHTML, /Sudah diunggah/);
});

test('a failed save keeps the review draft and reports that nothing changed', async () => {
  const pkg = samplePackage();
  const { context, element, click } = appContext({
    fetchImpl: async (url, options) => {
      if (url === '/api/ai/production') return response({ package: pkg });
      if (url.endsWith('/production-package')) return { ok: false, status: 500, json: async () => ({ error: 'Gagal menyimpan paket produksi. Data proyek tidak berubah.' }) };
      return response(url === "/api/projects" ? [] : {});
    },
  });
  openPackageTab(context, packageProject());
  await tick();
  await click({ id: 'build-package' });
  await click({ id: 'save-package' });
  assert.match(element('#tab-content').innerHTML, /plan-notice error" role="status">Paket belum tersimpan: Gagal menyimpan paket produksi/);
  assert.match(element('#tab-content').innerHTML, /Draf paket di layar ini belum tersimpan/);
  assert.match(element('#tab-content').innerHTML, /plan-notice error" role="status">[^<]*<\/p><div class="draft-actions"><button class="soft-button" id="discard-package"/, 'the notice sits right above the draft actions');
  assert.equal(/Paket belum tersimpan/.test(element('#toast').textContent), false, 'the failure is not shown as a toast over the draft');
  assert.notEqual(vm.runInContext('packageDraft', context), null, 'draft stays available for a retry');
  assert.match(element('#tab-content').innerHTML, /Tinjau paket sebelum disimpan/);
  assert.equal(vm.runInContext('current.data.productionPackage', context), undefined);
});

test('a project created before packages existed shows the empty state without any error', async () => {
  const { context, element } = appContext();
  openPackageTab(context, packageProject());
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.ok(html.includes('Belum ada paket produksi'));
  assert.equal(html.includes('pkg-error'), false);
});

test('advanced JSON is collapsed by default and the page does not claim generated images or video', async () => {
  const { context, element } = appContext();
  openPackageTab(context, packageProject(savedView(samplePackage())));
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.ok(html.includes('<details class="pkg-advanced">'));
  assert.equal(/<details class="pkg-advanced"[^>]*open/.test(html), false);
  assert.ok(html.includes('Aplikasi ini belum membuat gambar atau video'));
  assert.equal(/(gambar|video|audio)\s+(sudah|telah)\s+dibuat/i.test(html), false);
});

test('a draft that refers to a removed upload warns before it can be saved', async () => {
  const pkg = samplePackage();
  pkg.clips[1].references = [{ kind: 'asset', id: 'a-hilang', role: 'produk' }];
  const { context, element } = appContext();
  openPackageTab(context, packageProject());
  vm.runInContext(`packageDraft=${JSON.stringify(pkg)};renderTab()`, context);
  await tick();
  assert.match(element('#tab-content').innerHTML, /tidak ada lagi di daftar unggahan/);
});

test('restoring an unsaved draft keeps the package the server saved, not the older copy in the backup', async () => {
  const serverProject = packageProject(savedView(samplePackage()));
  const staleBackup = { ...packageProject(savedView({ ...samplePackage(), concept: 'Konsep lama' })), idea: 'Draf lain' };
  const { context, session } = appContext({ projects: [serverProject], confirmImpl: () => true });
  session.set('ai-video-studio:unsaved:p1', JSON.stringify(staleBackup));
  await tick();
  vm.runInContext("openProject('p1')", context);
  assert.equal(vm.runInContext('current.idea', context), 'Draf lain');
  assert.equal(vm.runInContext('current.data.productionPackage.package.concept', context), samplePackage().concept);
});

// Understanding first, package second (B3 fidelity work).
test('understanding is requested with the user details, corrected by the user, and only then confirmed', async () => {
  const calls = [];
  const summary = { core: 'Rani menolong kucing.', message: 'Keberanian kecil.', characters: ['Rani — remaja: penolong'], locations: ['Kota kecil — sore hujan'], sequence: ['1. Rani menemukan kucing'], unclear: ['Akhir cerita'], suggestions: ['Musik lembut'] };
  const p = packageProject(null, null);
  p.data.character = 'Rani, remaja berambut ikal';
  p.data.world = 'kota kecil';
  p.data.message = 'keberanian';
  const { context, element, click, change } = appContext({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/ai/gemini/status') return response({ configured: true });
      if (url === '/api/ai/understanding') return response({ understanding: summary });
      if (options?.method === 'PUT') return response(JSON.parse(options.body));
      return response(url === '/api/projects' ? [] : {});
    },
  });
  openIdeaTab(context, p);
  await tick();
  assert.ok(element('#build-understanding'), 'the plan button is on the idea tab');
  await click({ id: 'build-understanding' });
  await tick();
  const body = JSON.parse(calls.find(call => call.url === '/api/ai/understanding').options.body);
  assert.equal(body.character, 'Rani, remaja berambut ikal');
  assert.equal(body.world, 'kota kecil');
  assert.equal(body.message, 'keberanian');
  assert.equal(calls.some(call => call.url === '/api/ai/production'), false, 'no package before confirmation');
  assert.match(element('#tab-content').innerHTML, /data-understanding-field="sequence"/);
  change({ dataset: { understandingField: 'sequence' }, value: '1. Rani menemukan kucing\n2. Kucing ikut pulang' });
  await click({ id: 'confirm-understanding' });
  await tick();
  const saves = calls.filter(call => call.url === '/api/projects/p1' && call.options?.method === 'PUT');
  const saved = JSON.parse(saves[saves.length - 1].options.body).data.understanding;
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.ideaAtConfirm, 'Kopi pagi');
  assert.deepEqual(saved.sequence, ['1. Rani menemukan kucing', '2. Kucing ikut pulang']);
  assert.match(element('#tab-content').innerHTML, /Rencana sudah Anda setujui/);
  vm.runInContext("setTab('package')", context);
  await tick();
  assert.equal(element('#build-package').disabled, false);
});

test('package generation stays blocked until the understanding is confirmed', async () => {
  const calls = [];
  const { context, element, click } = appContext({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/ai/gemini/status') return response({ configured: true });
      return response(url === '/api/projects' ? [] : {});
    },
  });
  openPackageTab(context, packageProject(null, { status: 'draft', core: 'Inti', message: '', characters: [], locations: [], sequence: [], unclear: [], suggestions: [] }));
  await tick();
  assert.equal(element('#build-package').disabled, true);
  await click({ id: 'build-package' });
  assert.equal(calls.some(call => call.url === '/api/ai/production'), false);
  assert.match(element('#toast').textContent, /Konfirmasi pemahaman/);
});

test('changing the idea after confirmation asks for a new confirmation before a package is made', async () => {
  const { context, element } = appContext();
  openPackageTab(context, packageProject(null, { ...confirmedUnderstanding(), ideaAtConfirm: 'Ide lama' }));
  await tick();
  assert.match(element('#tab-content').innerHTML, /Ide sudah berubah sejak rencana disetujui/);
  assert.equal(element('#build-package').disabled, true);
});

test('each clip offers an Indonesian and an English prompt and names the English details still missing', async () => {
  const copied = [];
  const pkg = samplePackage();
  pkg.clips[1].en = { action: 'Pouring' };
  const { context, element, click } = appContext({ clipboardImpl: async text => { copied.push(text); } });
  openPackageTab(context, packageProject(savedView(pkg)));
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.ok(html.includes('Salin prompt Inggris · klip 1'));
  assert.ok(html.includes('Prompt Inggris belum lengkap:'));
  assert.ok(html.includes('klip 2: Camera, Lighting'));
  await click({ copyClip: '1', copyLang: 'en' });
  await tick();
  assert.ok(copied[0].includes('- Lighting: morning light'));
});

test('a package saved before English prompts existed shows that English is not available yet', async () => {
  const pkg = samplePackage();
  pkg.clips.forEach(clip => { clip.prompt_en = ''; clip.en = {}; });
  const { context, element } = appContext();
  openPackageTab(context, packageProject(savedView(pkg)));
  await tick();
  assert.ok(element('#tab-content').innerHTML.includes('Belum tersedia untuk paket ini'));
});

test('the idea is shown in full, not cut', async () => {
  const longIdea = 'Rani menolong kucing tersesat di kota kecil. '.repeat(8).trim();
  const p = packageProject();
  p.idea = longIdea;
  const { context, element } = appContext();
  openPackageTab(context, p);
  await tick();
  assert.ok(element('#tab-content').innerHTML.includes(longIdea));
});

test('the story draft request carries the characters, location, and message typed on the Ide form', async () => {
  const calls = [];
  const existing = project();
  existing.idea = 'Rani menolong kucing';
  existing.data.character = 'Rani, remaja berambut ikal';
  existing.data.world = 'kota kecil';
  existing.data.message = 'keberanian kecil';
  const { context, element } = appContext({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/ai/story') return response({ draft: { alternatives: [{ title: 'A', scenes: [] }] } });
      return response(url === '/api/projects' ? [] : {});
    },
  });
  vm.runInContext(`current=${JSON.stringify(existing)};projects=[current];activeTab='idea'`, context);
  element('#ai-provider').value = 'gemini';
  element('#idea-input').value = 'Rani menolong kucing';
  element('#duration-input').value = '30 detik';
  element('#style-input').value = 'Sinematik natural';
  await vm.runInContext('requestAIDraft()', context);
  const payload = JSON.parse(calls.find(call => call.url === '/api/ai/story').options.body);
  assert.equal(payload.character, 'Rani, remaja berambut ikal');
  assert.equal(payload.world, 'kota kecil');
  assert.equal(payload.message, 'keberanian kecil');
});

// Repair round: duration and style, the user's own message, AI suggestions, and confirmation status.
test('the duration and style shown on the form are the stored values and go into the story request', async () => {
  const calls = [];
  const p = project();
  p.idea = 'Rani menolong kucing';
  const { context, element } = appContext({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/ai/story') return response({ draft: { alternatives: [{ title: 'A', scenes: [] }] } });
      return response(url === '/api/projects' ? [] : {});
    },
  });
  vm.runInContext(`current=${JSON.stringify(p)};projects=[current];activeTab='idea';renderProject()`, context);
  await tick();
  assert.equal(vm.runInContext('current.data.duration', context), '30 detik', 'the default the form shows is stored');
  assert.equal(vm.runInContext('current.data.style', context), 'Sinematik natural');
  element('#duration-input').value = '2 menit';
  element('#duration-input').onchange();
  element('#style-input').value = 'Animasi 3D';
  element('#style-input').onchange();
  element('#ai-provider').value = 'gemini';
  element('#idea-input').value = 'Rani menolong kucing';
  await vm.runInContext('requestAIDraft()', context);
  const body = JSON.parse(calls.find(call => call.url === '/api/ai/story').options.body);
  assert.equal(body.duration, '2 menit');
  assert.equal(body.style, 'Animasi 3D');
});

test('the understanding request, the package request, and the target duration all use the stored duration and style', async () => {
  const calls = [];
  const p = packageProject(null, null);
  p.data.duration = '2 menit';
  p.data.style = 'Animasi 3D';
  const { context, element, click } = appContext({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/ai/gemini/status') return response({ configured: true });
      if (url === '/api/ai/understanding') return response({ understanding: { core: 'Inti', message: '', characters: [], locations: [], sequence: [], unclear: [], suggestions: [], acceptedSuggestions: [] } });
      if (url === '/api/ai/production') return response({ package: samplePackage() });
      if (url.endsWith('/production-package')) return response({ ...project('p1'), data: { ...project('p1').data, productionPackage: savedView(JSON.parse(options.body).package) } });
      if (options?.method === 'PUT') return response(JSON.parse(options.body));
      return response(url === '/api/projects' ? [] : {});
    },
  });
  openIdeaTab(context, p);
  await tick();
  await click({ id: 'build-understanding' });
  await tick();
  const understanding = JSON.parse(calls.find(call => call.url === '/api/ai/understanding').options.body);
  assert.equal(understanding.duration, '2 menit');
  assert.equal(understanding.style, 'Animasi 3D');

  vm.runInContext("current.data.understanding={...current.data.understanding,status:'confirmed',ideaAtConfirm:current.idea};renderTab()", context);
  await tick();
  await tick();
  await click({ id: 'build-package' });
  await tick();
  const production = JSON.parse(calls.find(call => call.url === '/api/ai/production').options.body);
  assert.equal(production.duration, '2 menit');
  assert.equal(production.style, 'Animasi 3D');
  await click({ id: 'save-package' });
  await tick();
  const save = JSON.parse(calls.filter(call => call.url.endsWith('/production-package')).pop().options.body);
  assert.equal(save.targetSeconds, 120, 'the 2-minute choice gives a 120-second target');
});

test('applying an AI draft never replaces the user\'s own main message; the AI message is offered separately', async () => {
  const puts = [];
  const p = project();
  p.idea = 'Rani menolong kucing';
  p.data.message = 'keberanian kecil';
  const { context, element, click } = appContext({
    fetchImpl: async (url, options) => {
      if (options?.method === 'PUT') { const body = JSON.parse(options.body); puts.push(body); return response(body); }
      return response(url === '/api/projects' ? [] : {});
    },
  });
  vm.runInContext(`current=${JSON.stringify(p)};projects=[current];activeTab='idea';aiDraftProvider='gemini';aiDraft=${JSON.stringify({ alternatives: [{ title: 'A', message: 'pesan lain dari AI', scenes: [{ title: 'Adegan 1', visual: 'Hujan' }], characters: [], locations: [] }] })};renderProject()`, context);
  await tick();
  await vm.runInContext('applyAIDraft()', context);
  await tick();
  assert.equal(vm.runInContext('current.data.message', context), 'keberanian kecil');
  assert.equal(vm.runInContext('current.data.messageSuggestion', context), 'pesan lain dari AI');
  assert.equal(puts[puts.length - 1].data.message, 'keberanian kecil');
  vm.runInContext("setTab('idea')", context);
  assert.match(element('#tab-content').innerHTML, /id="use-message-suggestion"/);
  await click({ id: 'use-message-suggestion' });
  await tick();
  assert.equal(vm.runInContext('current.data.message', context), 'pesan lain dari AI', 'the user chooses the suggestion explicitly');
});

test('an AI suggestion is binding only after the user accepts it, and unaccepted ones are never sent', async () => {
  const puts = [];
  const calls = [];
  const p = packageProject(null, { status: 'draft', core: 'Inti cerita', message: '', characters: [], locations: [], sequence: [], unclear: [], suggestions: ['Usulan A', 'Usulan B'], acceptedSuggestions: [] });
  const { context, element, click, change } = appContext({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/ai/gemini/status') return response({ configured: true });
      if (url === '/api/ai/production') return response({ package: samplePackage() });
      if (options?.method === 'PUT') { const body = JSON.parse(options.body); puts.push(body); return response(body); }
      return response(url === '/api/projects' ? [] : {});
    },
  });
  openIdeaTab(context, p);
  await tick();
  const before = element('#tab-content').innerHTML;
  assert.ok(before.includes('data-accept-suggestion="0"') && before.includes('data-accept-suggestion="1"'));
  change({ dataset: { acceptSuggestion: '0' }, checked: true });
  change({ dataset: { acceptSuggestion: '1' }, checked: true });
  change({ dataset: { acceptSuggestion: '1' }, checked: false });
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(current.data.understanding.acceptedSuggestions)', context)), ['Usulan A']);
  await click({ id: 'confirm-understanding' });
  await tick();
  const saved = puts[puts.length - 1].data.understanding;
  assert.equal(saved.status, 'confirmed');
  assert.deepEqual(saved.acceptedSuggestions, ['Usulan A']);
  assert.match(element('#tab-content').innerHTML, /Usulan AI yang tidak dipakai: Usulan B/);
  await tick();
  await click({ id: 'build-package' });
  await tick();
  const production = calls.find(call => call.url === '/api/ai/production');
  assert.ok(production, 'package request sent after confirmation');
  assert.equal(production.options.body.includes('Usulan B'), false, 'the unaccepted suggestion is not sent as a binding decision');
});

test('the confirmation shows as confirmed only after the save succeeds, and a failed save can be retried', async () => {
  let saveWorks = false;
  const puts = [];
  const p = packageProject(null, { status: 'draft', core: 'Inti cerita', message: '', characters: [], locations: [], sequence: [], unclear: [], suggestions: [], acceptedSuggestions: [] });
  const { context, element, click } = appContext({
    fetchImpl: async (url, options) => {
      if (url === '/api/ai/gemini/status') return response({ configured: true });
      if (options?.method === 'PUT') {
        const body = JSON.parse(options.body);
        puts.push(body);
        if (!saveWorks) return { ok: false, status: 500, json: async () => ({ error: 'Gagal menyimpan' }) };
        return response(body);
      }
      return response(url === '/api/projects' ? [] : {});
    },
  });
  openIdeaTab(context, p);
  await tick();
  await click({ id: 'confirm-understanding' });
  await tick();
  await tick();
  assert.match(element('#tab-content').innerHTML, /plan-notice error" role="status">Pemahaman belum tersimpan/);
  assert.equal(element('#toast').textContent, '', 'no toast over the plan card');
  assert.equal(vm.runInContext('current.data.understanding.status', context), 'draft');
  const failed = element('#tab-content').innerHTML;
  assert.equal(failed.includes('Pemahaman sudah dikonfirmasi'), false);
  assert.ok(failed.includes('id="confirm-understanding"'));
  vm.runInContext("setTab('package')", context);
  await tick();
  assert.equal(element('#build-package').disabled, true, 'the package stays blocked');
  vm.runInContext("setTab('idea')", context);
  await tick();
  saveWorks = true;
  await click({ id: 'confirm-understanding' });
  await tick();
  assert.equal(vm.runInContext('current.data.understanding.status', context), 'confirmed');
  assert.match(element('#tab-content').innerHTML, /Rencana sudah Anda setujui/);
  assert.equal(puts[puts.length - 1].data.understanding.status, 'confirmed');
});

// Simple plan flow: one idea box, one plan button, a reviewable plan, and folded advanced settings.
const planFetch = ({ configured = true, record = [], understanding = null, projects = [] } = {}) => async (url, options) => {
  record.push({ url, options });
  if (url === '/api/ai/gemini/status') return response({ configured });
  if (url === '/api/ai/understanding') return response({ understanding });
  if (options?.method === 'PUT') return response(JSON.parse(options.body));
  return response(url === '/api/projects' ? projects : {});
};
const reviewablePlan = (overrides = {}) => ({
  status: 'draft', core: 'Ibu mencari alamat anaknya.', message: '', characters: ['Ibu Sari — ibu tua'], locations: ['Kota seberang — sore hujan'],
  sequence: ['1. Ibu menemukan surat'], unclear: [], suggestions: [], acceptedSuggestions: [],
  goal: 'Cerita pendek hangat', recommendedStyle: 'Ilustrasi hangat', camera: ['medium shot'], assetsNeeded: ['foto Ibu Sari'], questions: [], ...overrides,
});

test('the idea tab leads with one input and one plan button, and the other settings start folded away', async () => {
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openIdeaTab(context, packageProject(null, null));
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.ok(html.includes('Buat Rencana Produksi'));
  const details = html.indexOf('<details class="advanced-settings">');
  assert.ok(details > html.indexOf('id="idea-input"'), 'settings come after the idea box');
  assert.equal(html.includes('<details class="advanced-settings" open'), false, 'settings start folded');
  for (const id of ['goal-input', 'duration-input', 'style-input', 'character-input', 'world-input', 'message-input', 'ai-provider', 'draft-story']) {
    assert.ok(html.indexOf(`id="${id}"`) > details, `${id} sits inside the folded settings`);
  }
});

test('the plan button stays disabled and explains the missing key when Gemini is not configured', async () => {
  const { context, element } = appContext({ fetchImpl: planFetch({ configured: false }) });
  openIdeaTab(context, packageProject(null, null));
  await tick();
  await tick();
  assert.equal(element('#build-understanding').disabled, true);
  assert.match(element('#plan-status').textContent, /GEMINI_API_KEY belum terbaca/);
});

test('a new plan is shown on the idea tab right after it is made, without switching tabs', async () => {
  const calls = [];
  const { context, element, click } = appContext({ fetchImpl: planFetch({ record: calls, understanding: reviewablePlan() }), confirmImpl: () => true });
  openIdeaTab(context, packageProject(null, null));
  await tick();
  await click({ id: 'build-understanding' });
  await tick();
  await tick();
  assert.equal(calls.filter(call => call.url === '/api/ai/understanding').length, 1);
  const html = element('#tab-content').innerHTML;
  assert.match(html, /id="plan-review"/);
  assert.match(html, /RENCANA PRODUKSI · PERIKSA DULU/);
  assert.ok(html.includes('id="confirm-understanding"'));
  assert.equal(calls.some(call => call.url === '/api/ai/production'), false, 'no package before approval');
});

test('the plan shows the AI recommendation for style, camera, assets and questions, and the user can take the recommended style', async () => {
  const p = packageProject(null, reviewablePlan({ questions: ['Siapa nama anak dalam surat?'] }));
  const { context, element, click } = appContext({ fetchImpl: planFetch() });
  openIdeaTab(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  for (const text of ['Ilustrasi hangat', 'medium shot', 'foto Ibu Sari', 'Siapa nama anak dalam surat?', 'id="answer-questions"', 'id="confirm-understanding"']) {
    assert.ok(html.includes(text), `missing: ${text}`);
  }
  assert.equal(vm.runInContext('current.data.style', context) === 'Ilustrasi hangat', false, 'the style is not taken without the user');
  await click({ id: 'use-recommended-style', style: 'Ilustrasi hangat' });
  await tick();
  assert.equal(vm.runInContext('current.data.style', context), 'Ilustrasi hangat');
  assert.equal(vm.runInContext('current.data.understanding.status', context), 'draft', 'taking a style does not approve the plan');
});

test('answering the AI questions sends the answer with the request, and an empty answer is never sent', async () => {
  const calls = [];
  const { context, element, click } = appContext({ fetchImpl: planFetch({ record: calls, understanding: reviewablePlan() }), confirmImpl: () => true });
  openIdeaTab(context, packageProject(null, reviewablePlan({ questions: ['Siapa nama anak dalam surat?'] })));
  await tick();
  element('#plan-answers').value = '';
  await click({ id: 'answer-questions' });
  await tick();
  assert.equal(calls.some(call => call.url === '/api/ai/understanding'), false, 'an empty answer is not sent');
  element('#plan-answers').value = 'Anaknya bernama Dimas';
  await click({ id: 'answer-questions' });
  await tick();
  await tick();
  const body = JSON.parse(calls.find(call => call.url === '/api/ai/understanding').options.body);
  assert.equal(body.answers, 'Anaknya bernama Dimas');
  assert.equal(body.idea, 'Kopi pagi');
});

test('the package tab shows the plan status and links back to the idea tab instead of repeating the editor', async () => {
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openPackageTab(context, packageProject(null, null));
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.ok(html.includes('Belum ada rencana'));
  assert.ok(html.includes('data-tab="idea"'));
  assert.equal(html.includes('data-understanding-field'), false, 'the plan editor lives on the idea tab only');
  assert.equal(html.includes('id="build-understanding"'), false);
});

test('the prompt tab points to the package prompts once a package is saved', async () => {
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openPackageTab(context, packageProject(savedView(samplePackage())));
  await tick();
  vm.runInContext("setTab('prompt')", context);
  await tick();
  assert.match(element('#tab-content').innerHTML, /Prompt per klip dari paket produksi ada di tab/);
});

test('the plan result message sits inside the plan area and the floating toast stays silent', async () => {
  const { context, element, click } = appContext({ fetchImpl: planFetch({ understanding: reviewablePlan() }), confirmImpl: () => true });
  openIdeaTab(context, packageProject(null, null));
  await tick();
  await click({ id: 'build-understanding' });
  await tick();
  await tick();
  assert.match(element('#tab-content').innerHTML, /class="plan-notice ok" role="status">Rencana dibuat/);
  assert.equal(element('#toast').textContent, '', 'no toast covers the plan card');
});

test('a failed plan request shows its reason inside the plan area, not as a toast', async () => {
  const fetchImpl = async (url) => {
    if (url === '/api/ai/gemini/status') return response({ configured: true });
    if (url === '/api/ai/understanding') return { ok: false, status: 502, json: async () => ({ error: 'Gemini tidak merespons' }) };
    return response(url === '/api/projects' ? [] : {});
  };
  const { context, element, click } = appContext({ fetchImpl });
  openIdeaTab(context, packageProject(null, null));
  await tick();
  await click({ id: 'build-understanding' });
  await tick();
  await tick();
  assert.match(element('#tab-content').innerHTML, /class="plan-notice error" role="status">Gemini tidak merespons/);
  assert.equal(element('#toast').textContent, '');
});

test('the advanced settings keep the open or folded state the user chose when the tab is redrawn', async () => {
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openIdeaTab(context, packageProject(null, null));
  await tick();
  assert.equal(element('#tab-content').innerHTML.includes('<details class="advanced-settings" open'), false, 'folded by default');
  vm.runInContext('advancedSettingsOpen = true; renderProject()', context);
  await tick();
  assert.match(element('#tab-content').innerHTML, /<details class="advanced-settings" open/);
  vm.runInContext("setTab('package')", context);
  vm.runInContext("setTab('idea')", context);
  await tick();
  assert.match(element('#tab-content').innerHTML, /<details class="advanced-settings" open/, 'still open after switching tabs');
});

test('a plan message does not follow the user into another project', async () => {
  const pA = packageProject(null, null);
  const pB = { ...project('p2'), idea: 'Ide proyek lain' };
  const { context, element, click } = appContext({ fetchImpl: planFetch({ understanding: reviewablePlan(), projects: [pA, pB] }), confirmImpl: () => true, projects: [pA, pB] });
  openIdeaTab(context, pA);
  await tick();
  await click({ id: 'build-understanding' });
  await tick();
  await tick();
  assert.match(element('#tab-content').innerHTML, /plan-notice ok/);
  vm.runInContext("openProject('p2')", context);
  await tick();
  assert.equal(element('#tab-content').innerHTML.includes('plan-notice'), false, 'the other project shows no plan message');
  vm.runInContext("openProject('p1')", context);
  await tick();
  assert.equal(element('#tab-content').innerHTML.includes('plan-notice'), false, 'returning does not revive a stale message');
});

test('a plan that finishes after the user switched projects is not shown in the new project', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (url, options) => {
    if (url === '/api/ai/gemini/status') return response({ configured: true });
    if (url === '/api/ai/understanding') { await gate; return response({ understanding: reviewablePlan() }); }
    if (options?.method === 'PUT') return response(JSON.parse(options.body));
    return response(url === '/api/projects' ? [pA, pB] : {});
  };
  const pA = packageProject(null, null);
  const pB = { ...project('p2'), idea: 'Ide proyek lain' };
  const { context, element, click } = appContext({ fetchImpl, confirmImpl: () => true, projects: [pA, pB] });
  openIdeaTab(context, pA);
  await tick();
  const pending = click({ id: 'build-understanding' });
  await tick();
  vm.runInContext("openProject('p2')", context);
  await tick();
  release();
  await pending;
  await tick();
  await tick();
  assert.equal(element('#tab-content').innerHTML.includes('plan-notice'), false, 'the late result is not announced in the new project');
  assert.equal(vm.runInContext("current.id", context), 'p2');
});

test('when saving the plan fails, the message says it is not saved and never claims the plan was created', async () => {
  let saveWorks = false;
  const fetchImpl = async (url, options) => {
    if (url === '/api/ai/gemini/status') return response({ configured: true });
    if (url === '/api/ai/understanding') return response({ understanding: reviewablePlan() });
    if (options?.method === 'PUT') {
      if (!saveWorks) return { ok: false, status: 500, json: async () => ({ error: 'Gagal menyimpan' }) };
      return response(JSON.parse(options.body));
    }
    return response(url === '/api/projects' ? [] : {});
  };
  const { context, element, click } = appContext({ fetchImpl, confirmImpl: () => true });
  openIdeaTab(context, packageProject(null, null));
  await tick();
  await click({ id: 'build-understanding' });
  await tick();
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /plan-notice error/);
  assert.match(html, /belum tersimpan/);
  assert.equal(html.includes('plan-notice ok'), false, 'no success message on a failed save');
  assert.match(element('#project-content').innerHTML, /id="retry-save"/, 'the retry action stays available after a failed save');
  saveWorks = true;
  await click({ id: 'build-understanding' });
  await tick();
  await tick();
  assert.match(element('#tab-content').innerHTML, /plan-notice ok/, 'a later successful save shows success');
});

test('a plan that fails after the user switched projects does not show its error in the new project', async () => {
  let fail;
  const gate = new Promise(resolve => { fail = resolve; });
  const fetchImpl = async (url, options) => {
    if (url === '/api/ai/gemini/status') return response({ configured: true });
    if (url === '/api/ai/understanding') { await gate; return { ok: false, status: 502, json: async () => ({ error: 'Gemini tidak merespons' }) }; }
    if (options?.method === 'PUT') return response(JSON.parse(options.body));
    return response(url === '/api/projects' ? [pA, pB] : {});
  };
  const pA = packageProject(null, null);
  const pB = { ...project('p2'), idea: 'Ide proyek lain' };
  const { context, element, click } = appContext({ fetchImpl, confirmImpl: () => true, projects: [pA, pB] });
  openIdeaTab(context, pA);
  await tick();
  const pending = click({ id: 'build-understanding' });
  await tick();
  vm.runInContext("openProject('p2')", context);
  await tick();
  fail();
  await pending;
  await tick();
  assert.equal(element('#tab-content').innerHTML.includes('Gemini tidak merespons'), false, 'the other project does not show the error');
  assert.equal(vm.runInContext("current.id", context), 'p2');
});

test('the idea tab says what leaves the app for Gemini, and the package tab says what the upload sends', async () => {
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openIdeaTab(context, packageProject(null, null));
  await tick();
  const idea = element('#tab-content').innerHTML;
  assert.match(idea, /Apa yang dikirim ke Gemini\?/);
  assert.match(idea, /Saat membuat rencana: ide, jenis video, durasi/);
  assert.match(idea, /Draft cerita mengirim hal yang sama tanpa jawaban/);
  assert.match(idea, /Gambar dan nama file tidak dikirim/);
  assert.ok(idea.indexOf('Apa yang dikirim ke Gemini?') < idea.indexOf('id="idea-input"'), 'the one-line summary sits above the idea box, visible on a phone');
  assert.ok(idea.indexOf('Saat membuat rencana') < idea.indexOf('<details class="advanced-settings"'), 'the details text is not buried in the folded settings');
  assert.match(idea, /class="studio-layout idea-layout"/);
  openPackageTab(context, packageProject(savedView(samplePackage())));
  await tick();
  const pkg = element('#tab-content').innerHTML;
  assert.match(pkg, /hanya id dan jenisnya yang dikirim; isi gambar dan nama file tidak/);
  assert.match(pkg, /Prompt dari paket produksi tersimpan\./);
});

test('the prompt tab names its source, and the storyboard prompts stay available', async () => {
  const { context, element, click } = appContext({ fetchImpl: planFetch() });
  openPackageTab(context, packageProject(savedView(samplePackage())));
  await tick();
  vm.runInContext("setTab('prompt')", context);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /Sumber prompt ini: adegan di tab Storyboard/);
  assert.match(html, /Prompt per klip dari paket produksi ada di tab/);
  assert.ok(html.includes('id="copy-prompt"'), 'the storyboard prompt and copy action are kept');
});

test('an in-card notice hides a floating toast that is still on screen', async () => {
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openIdeaTab(context, packageProject(null, null));
  await tick();
  element('#toast').classList.add('show');
  vm.runInContext("setPlanNotice('error', 'Contoh')", context);
  assert.equal(element('#toast').classList.contains('show'), false, 'the toast no longer covers the card');
});

// Tahap 2, Mode 1: Gemini is used by hand. The app prepares prompts and keeps the uploaded results linked.
const openStoryboard = (context, p) => vm.runInContext(`current=${JSON.stringify(p)};projects=[current];activeTab='storyboard';renderProject()`, context);
const visualProject = () => {
  const p = project('p1');
  p.idea = 'Ibu dan anak';
  p.data = {
    ...p.data, duration: '30 detik', style: 'Ilustrasi hangat',
    entities: {
      characters: [{ id: 'char-rani', name: 'Rani', role: 'tokoh utama', appearance: 'rambut ikal, jaket kuning', signature: 'selalu memakai topi merah', source: 'manual' }],
      locations: [{ id: 'loc-ruang', name: 'Ruang tamu', description: 'lampu kuning', source: 'manual' }],
      products: [],
    },
    scenes: [{ id: 's1', title: 'Pertemuan', purpose: 'Rani membuka pintu', visual: 'Rani berdiri di ambang pintu', action: 'Rani membuka pintu', expression: 'terkejut', location: 'Ruang tamu', time: 'sore', camera: 'medium shot', lighting: 'hangat', characterIds: ['char-rani'], locationId: 'loc-ruang', productIds: [], referenceAssetIds: [], assetIds: [], productionChecklist: {} }],
    assets: [],
  };
  return p;
};
const uploadingFetch = (asset, saved = []) => async (url, options) => {
  if (options?.method === 'PUT') { saved.push(JSON.parse(options.body)); return response(JSON.parse(options.body)); }
  if (options?.method === 'POST' && url.endsWith('/assets')) return response({ asset });
  return response(url === '/api/projects' ? [] : {});
};

test('the storyboard shows a character sheet with facts, an editable Gemini prompt, copy, and a Gemini link', async () => {
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, visualProject());
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /LEMBAR KARAKTER · GEMINI MANUAL/);
  assert.match(html, /<h4>Rani<\/h4>/);
  assert.match(html, /selalu memakai topi merah/);
  assert.match(html, /data-char-prompt="char-rani"/);
  assert.match(html, /data-copy-char="char-rani"/);
  assert.match(html, /href="https:\/\/gemini\.google\.com\/"/);
  assert.match(html, /data-entity-field="signature"/, 'the character form has the distinguishing-features field');
  assert.equal(/gambar (sudah|telah) dibuat/i.test(html), false, 'no claim that an image exists yet');
});

test('a corrected character prompt is what gets copied, and the reset button restores the generated one', async () => {
  const copied = [];
  const { context, element, click, input } = appContext({ fetchImpl: planFetch(), clipboardImpl: async text => { copied.push(text); } });
  openStoryboard(context, visualProject());
  await tick();
  input({ dataset: { charPrompt: 'char-rani' }, value: 'Rani versi koreksi, rambut panjang.' });
  await click({ copyChar: 'char-rani' });
  await tick();
  assert.equal(copied[0], 'Rani versi koreksi, rambut panjang.');
  await click({ resetPrompt: 'char:char-rani' });
  await tick();
  assert.match(element('#tab-content').innerHTML, /Tokoh: Rani/);
  assert.equal(vm.runInContext("'char:char-rani' in current.data.visualPrompts", context), false);
});

test('a scene moves from prompt ready, to waiting for Gemini, to a linked visual reference after the upload', async () => {
  const copied = [];
  const saved = [];
  const { context, element, click, change } = appContext({
    fetchImpl: uploadingFetch({ id: 'asset-scene-1', name: 'adegan-1.png', url: '/uploads/adegan-1.png', type: 'Adegan' }, saved),
    clipboardImpl: async text => { copied.push(text); },
  });
  openStoryboard(context, visualProject());
  await tick();
  assert.match(element('#tab-content').innerHTML, /Status:<\/b> Prompt siap/);
  await click({ copyScene: 's1' });
  await tick();
  assert.match(element('#tab-content').innerHTML, /Menunggu gambar dari Gemini/);
  assert.match(copied[0], /Adegan: Pertemuan/);
  assert.match(copied[0], /Rani \(rambut ikal, jaket kuning\)/);
  change({ dataset: { sceneUpload: 's1' }, files: [{ name: 'adegan-1.png', type: 'image/png' }] });
  for (let i = 0; i < 6; i++) await tick();
  assert.match(element('#tab-content').innerHTML, /Referensi visual tersedia/);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(current.data.scenes[0].referenceAssetIds)', context)), ['asset-scene-1']);
  assert.equal(vm.runInContext('current.data.assets[0].sceneId', context), 's1');
});

test('a character reference is saved with its label and character, and the label can be changed', async () => {
  const saved = [];
  const { context, element, change } = appContext({ fetchImpl: uploadingFetch({ id: 'asset-rani-1', name: 'wajah.png', url: '/uploads/wajah.png', type: 'Karakter' }, saved) });
  openStoryboard(context, visualProject());
  await tick();
  element('[data-ref-label-select="characters:char-rani"]').value = 'pakaian';
  change({ dataset: { refUpload: '', refKind: 'characters', refId: 'char-rani' }, files: [{ name: 'wajah.png', type: 'image/png' }] });
  for (let i = 0; i < 6; i++) await tick();
  assert.ok(vm.runInContext('saveTimer', context), 'an autosave is scheduled after the link is made, without a manual save');
  const asset = JSON.parse(vm.runInContext('JSON.stringify(current.data.assets[0])', context));
  assert.deepEqual([asset.label, asset.entityKind, asset.entityId], ['pakaian', 'characters', 'char-rani']);
  assert.match(element('#tab-content').innerHTML, /<span>wajah\.png<\/span>/);
  change({ dataset: { assetLabel: 'asset-rani-1' }, value: 'wajah' });
  await tick();
  assert.equal(vm.runInContext('current.data.assets[0].label', context), 'wajah');
});

test('an older project without the new fields still opens the storyboard, with an empty sheet and no corrections', async () => {
  const p = visualProject();
  delete p.data.visualPrompts;
  delete p.data.visualState;
  delete p.data.entities.characters[0].signature;
  p.data.assets = [{ id: 'a-old', name: 'lama.png', url: '/uploads/lama.png', type: 'Karakter' }];
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /<h4>Rani<\/h4>/);
  assert.match(html, /belum diisi/, 'a missing distinguishing feature is shown as not filled in');
  assert.equal(vm.runInContext('Object.keys(current.data.visualPrompts).length', context), 0);
  assert.match(html, /Status:<\/b> Prompt siap/);
});

test('corrections, labels, and scene status are saved with the project and still show after a reload', async () => {
  const saved = [];
  const { context, element, change, click } = appContext({ fetchImpl: uploadingFetch({ id: 'asset-rani-2', name: 'ekspresi.png', url: '/uploads/ekspresi.png', type: 'Karakter' }, saved), clipboardImpl: async () => {} });
  openStoryboard(context, visualProject());
  await tick();
  element('[data-ref-label-select="characters:char-rani"]').value = 'ekspresi';
  change({ dataset: { refUpload: '', refKind: 'characters', refId: 'char-rani' }, files: [{ name: 'ekspresi.png', type: 'image/png' }] });
  for (let i = 0; i < 6; i++) await tick();
  await click({ copyScene: 's1' });
  await vm.runInContext('saveNow()', context);
  const stored = saved[saved.length - 1].data;
  assert.equal(typeof stored.visualState['scene:s1'].copiedAt, 'string');
  assert.equal(stored.assets.find(a => a.id === 'asset-rani-2').label, 'ekspresi');
  const reloaded = { ...visualProject(), data: stored };
  const second = appContext({ fetchImpl: planFetch(), projects: [reloaded] });
  openStoryboard(second.context, reloaded);
  await tick();
  const html = second.element('#tab-content').innerHTML;
  assert.match(html, /Menunggu gambar dari Gemini/);
  assert.match(html, /<option value="ekspresi" selected>/);
});

test('clicks, changes, and typing outside the visual controls do not touch project data when no project is open', async () => {
  const { context, click, change, input } = appContext({ fetchImpl: planFetch() });
  vm.runInContext('current=null', context);
  await assert.doesNotReject(click({ tab: 'idea' }));
  await assert.doesNotReject(click({ open: 'p1' }));
  assert.doesNotThrow(() => change({ dataset: { other: 'x' }, value: 'y' }));
  assert.doesNotThrow(() => input({ dataset: {}, value: 'y' }));
});

test('the scene prompt names the saved character references by label, and each step to Gemini is spelled out', async () => {
  const { context, element } = appContext({ fetchImpl: uploadingFetch({ id: 'a-wajah', name: 'wajah.png', url: '/uploads/w.png', type: 'Karakter' }) });
  const p = visualProject();
  p.data.assets = [{ id: 'a-wajah', name: 'wajah.png', url: '/uploads/w.png', type: 'Karakter', entityKind: 'characters', entityId: 'char-rani', label: 'wajah' }];
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /Referensi tokoh yang sudah disimpan \(lampirkan di Gemini\): Rani \(Wajah\)/);
  assert.match(html, /Langkah: salin prompt → buka Gemini/);
  assert.match(html, /belum ada gambar sampai Anda mengunggahnya/);
});

// Round 2 of Mode 1: previews, replace and delete, locations and products with references.
const assetFetch = ({ queue = [], saved = [], deleted = [] } = {}) => async (url, options) => {
  if (options?.method === 'PUT') { saved.push(JSON.parse(options.body)); return response(JSON.parse(options.body)); }
  if (options?.method === 'DELETE') { deleted.push(url); return response({}); }
  if (options?.method === 'POST' && url.endsWith('/assets')) return response({ asset: queue.shift() });
  return response(url === '/api/projects' ? [] : {});
};
const roundTwoProject = () => {
  const p = visualProject();
  p.data.entities.locations = [
    { id: 'loc-ruang', name: 'Ruang tamu', description: 'lampu kuning', source: 'manual' },
    { id: 'loc-dapur', name: 'Dapur', description: 'kompor tua', source: 'manual' },
  ];
  p.data.entities.products = [{ id: 'prod-kopi', name: 'Kopi kemasan', description: 'kemasan biru, tutup emas', source: 'manual' }, { id: 'prod-lain', name: 'Teh lain', description: 'kotak hijau', source: 'manual' }];
  p.data.scenes[0].locationId = 'loc-ruang';
  p.data.scenes[0].productIds = ['prod-kopi'];
  return p;
};

test('a character card shows a thumbnail after the upload, and the label can be changed and the image deleted', async () => {
  const deleted = [];
  const { context, element, change, click } = appContext({ fetchImpl: assetFetch({ queue: [{ id: 'a-rani', name: 'wajah.png', url: '/uploads/rani-wajah.png', type: 'Karakter' }], deleted }), confirmImpl: () => true });
  openStoryboard(context, visualProject());
  await tick();
  change({ dataset: { refUpload: '', refKind: 'characters', refId: 'char-rani' }, files: [{ name: 'wajah.png', type: 'image/png' }] });
  for (let i = 0; i < 6; i++) await tick();
  let html = element('#tab-content').innerHTML;
  assert.match(html, /<img class="ref-thumb" src="\/uploads\/rani-wajah\.png"/, 'the uploaded image is previewed on the character card');
  change({ dataset: { assetLabel: 'a-rani' }, value: 'ekspresi' });
  await tick();
  assert.equal(vm.runInContext("current.data.assets[0].label", context), 'ekspresi');
  await click({ deleteAsset: 'a-rani' });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(vm.runInContext('current.data.assets.length', context), 0, 'the reference is removed from the project');
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /\/assets\/a-rani$/);
});

test('replacing a reference keeps its label and link, and removes the old image', async () => {
  const deleted = [];
  const p = visualProject();
  p.data.assets = [{ id: 'a-old', name: 'lama.png', url: '/uploads/lama.png', type: 'Karakter', entityKind: 'characters', entityId: 'char-rani', label: 'pakaian' }];
  const { context, change } = appContext({ fetchImpl: assetFetch({ queue: [{ id: 'a-new', name: 'baru.png', url: '/uploads/baru.png', type: 'Karakter' }], deleted }), confirmImpl: () => true });
  openStoryboard(context, p);
  await tick();
  change({ dataset: { refReplace: 'a-old' }, files: [{ name: 'baru.png', type: 'image/png' }] });
  for (let i = 0; i < 8; i++) await tick();
  const assets = JSON.parse(vm.runInContext('JSON.stringify(current.data.assets)', context));
  assert.deepEqual(assets.map(a => a.id), ['a-new']);
  assert.deepEqual([assets[0].label, assets[0].entityKind, assets[0].entityId], ['pakaian', 'characters', 'char-rani']);
  assert.match(deleted.join(' '), /\/assets\/a-old$/);
});

test('replacing a reference saves the new link before the old image is deleted, so the old record cannot return', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(`${options?.method || 'GET'} ${url}`);
    if (options?.method === 'PUT') return response(JSON.parse(options.body));
    if (options?.method === 'DELETE') return response({ project: { ...visualProject(), data: { ...visualProject().data, assets: [] } } });
    if (options?.method === 'POST' && url.endsWith('/assets')) return response({ asset: { id: 'a-new', name: 'baru.png', url: '/uploads/baru.png', type: 'Karakter' } });
    return response(url === '/api/projects' ? [] : {});
  };
  const p = visualProject();
  p.data.assets = [{ id: 'a-old', name: 'lama.png', url: '/uploads/lama.png', type: 'Karakter', entityKind: 'characters', entityId: 'char-rani' }];
  const { context, change } = appContext({ fetchImpl, confirmImpl: () => true });
  openStoryboard(context, p);
  await tick();
  change({ dataset: { refReplace: 'a-old' }, files: [{ name: 'baru.png', type: 'image/png' }] });
  for (let i = 0; i < 8; i++) await tick();
  const deleteAt = calls.findIndex(c => c.startsWith('DELETE'));
  assert.notEqual(deleteAt, -1, 'the old image is deleted');
  assert.ok(calls.slice(0, deleteAt).some(c => c.startsWith('PUT')), 'a save of the new link happens before the delete');
  assert.deepEqual(calls.slice(deleteAt + 1).filter(c => c.startsWith('PUT')), [], 'no later save may bring back the deleted record');
});

test('a location can hold several reference images, and no duplicate location is created', async () => {
  const queue = [{ id: 'a-r1', name: 'ruang-1.png', url: '/uploads/r1.png', type: 'Lokasi' }, { id: 'a-r2', name: 'ruang-2.png', url: '/uploads/r2.png', type: 'Lokasi' }];
  const { context, element, change } = appContext({ fetchImpl: assetFetch({ queue }), confirmImpl: () => true });
  openStoryboard(context, roundTwoProject());
  await tick();
  element('[data-ref-label-select="locations:loc-ruang"]').value = 'detail';
  change({ dataset: { refUpload: '', refKind: 'locations', refId: 'loc-ruang' }, files: [{ name: 'ruang-1.png', type: 'image/png' }] });
  for (let i = 0; i < 6; i++) await tick();
  change({ dataset: { refUpload: '', refKind: 'locations', refId: 'loc-ruang' }, files: [{ name: 'ruang-2.png', type: 'image/png' }] });
  for (let i = 0; i < 6; i++) await tick();
  const assets = JSON.parse(vm.runInContext('JSON.stringify(current.data.assets)', context));
  assert.deepEqual(assets.map(a => [a.entityKind, a.entityId, a.label]), [['locations', 'loc-ruang', 'detail'], ['locations', 'loc-ruang', 'detail']]);
  assert.equal(vm.runInContext('current.data.entities.locations.length', context), 2, 'no duplicate location entity');
  assert.match(element('#tab-content').innerHTML, /src="\/uploads\/r2\.png"/);
});

test('the scene prompt names only the linked location and products, with their saved references', async () => {
  const copied = [];
  const p = roundTwoProject();
  p.data.assets = [
    { id: 'l1', name: 'ruang.png', url: '/uploads/l1.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-ruang', label: 'utama' },
    { id: 'l2', name: 'dapur.png', url: '/uploads/l2.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-dapur', label: 'utama' },
    { id: 'p1', name: 'kopi.png', url: '/uploads/p1.png', type: 'Produk', entityKind: 'products', entityId: 'prod-kopi', label: 'utama' },
    { id: 'p2', name: 'teh.png', url: '/uploads/p2.png', type: 'Produk', entityKind: 'products', entityId: 'prod-lain', label: 'detail' },
  ];
  const { context, click } = appContext({ fetchImpl: planFetch(), clipboardImpl: async text => { copied.push(text); } });
  openStoryboard(context, p);
  await tick();
  await click({ copyScene: 's1' });
  const text = copied[0];
  assert.match(text, /Referensi lokasi yang sudah disimpan \(lampirkan di Gemini\): Ruang tamu \(Tampilan utama\)/);
  assert.match(text, /Produk: Kopi kemasan \(kemasan biru, tutup emas\)/);
  assert.match(text, /Referensi produk yang sudah disimpan \(lampirkan di Gemini\): Kopi kemasan \(Tampilan utama\)/);
  assert.equal(/Dapur|kompor tua/.test(text), false, 'the unlinked location is not in the prompt');
  assert.equal(/Teh lain|kotak hijau/.test(text), false, 'the unlinked product is not in the prompt');
});

test('products can be added, linked to a scene and unlinked, and removing a product keeps the scene location', async () => {
  const { context, change, click } = appContext({ fetchImpl: planFetch(), confirmImpl: () => true });
  openStoryboard(context, roundTwoProject());
  await tick();
  await click({ id: 'add-product' });
  await tick();
  const newId = vm.runInContext('current.data.entities.products[2].id', context);
  assert.match(newId, /^prod-/);
  change({ dataset: { sceneProduct: newId, sceneId: 's1' }, checked: true });
  assert.ok(JSON.parse(vm.runInContext('JSON.stringify(current.data.scenes[0].productIds)', context)).includes(newId));
  change({ dataset: { sceneProduct: newId, sceneId: 's1' }, checked: false });
  assert.equal(vm.runInContext('current.data.scenes[0].productIds.includes(' + JSON.stringify(newId) + ')', context), false);
  vm.runInContext("removeEntity(current.data,'products','prod-kopi')", context);
  assert.equal(vm.runInContext('current.data.scenes[0].locationId', context), 'loc-ruang', 'removing a product does not clear the scene location');
  assert.equal(vm.runInContext('current.data.scenes[0].productIds.length', context), 0);
});

test('references, product links, and the location link all survive a save and a reload', async () => {
  const saved = [];
  const queue = [{ id: 'a-ruang', name: 'ruang.png', url: '/uploads/ruang.png', type: 'Lokasi' }];
  const { context, element, change, click } = appContext({ fetchImpl: assetFetch({ queue, saved }), clipboardImpl: async () => {} });
  openStoryboard(context, roundTwoProject());
  await tick();
  change({ dataset: { refUpload: '', refKind: 'locations', refId: 'loc-ruang' }, files: [{ name: 'ruang.png', type: 'image/png' }] });
  for (let i = 0; i < 6; i++) await tick();
  await click({ copyScene: 's1' });
  await vm.runInContext('saveNow()', context);
  const stored = saved[saved.length - 1].data;
  const reloaded = { ...roundTwoProject(), data: stored };
  const second = appContext({ fetchImpl: planFetch(), projects: [reloaded] });
  openStoryboard(second.context, reloaded);
  await tick();
  const html = second.element('#tab-content').innerHTML;
  assert.match(html, /src="\/uploads\/ruang\.png"/);
  assert.match(html, /data-scene-product="prod-kopi" data-scene-id="s1" checked/);
  assert.match(html, /data-scene-location[\s\S]*<option value="loc-ruang" selected>/);
});

test('an older project with no product list and no location references still opens cleanly', async () => {
  const p = visualProject();
  delete p.data.entities.products;
  delete p.data.entities.locations[0];
  p.data.entities.locations = [];
  p.data.scenes[0].productIds = undefined;
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(current.data.entities.products)', context)), []);
  assert.match(element('#tab-content').innerHTML, /id="add-product"/);
});

// Phase 2 of Mode 1: location and product prompts, editing and restoring, storyboard attachment list.
test('a location has a default Gemini prompt that keeps its identity, is copied, and names saved references as guidance', async () => {
  const copied = [];
  const p = roundTwoProject();
  p.data.assets = [{ id: 'l1', name: 'ruang.png', url: '/uploads/l1.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-ruang', label: 'utama' }];
  const { context, element, click } = appContext({ fetchImpl: planFetch(), clipboardImpl: async text => { copied.push(text); } });
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /data-entity-prompt="loc:loc-ruang"/, 'the location prompt is editable');
  assert.match(html, /data-copy-entity="loc:loc-ruang"/);
  assert.match(html, /href="https:\/\/gemini\.google\.com\/"[^>]*>Buka Gemini/, 'the location prompt opens Gemini');
  await click({ copyEntity: 'loc:loc-ruang' });
  const text = copied[0];
  assert.match(text, /Lokasi: Ruang tamu/);
  assert.match(text, /Suasana dan detail: lampu kuning/);
  assert.match(text, /tata ruang, arsitektur/, 'the prompt keeps the layout and architecture fixed');
  assert.match(text, /Referensi yang sudah ada untuk lokasi ini: Tampilan utama \(ruang\.png\)/, 'the saved image of the same location is guidance');
  assert.equal(/Dapur|kompor tua/.test(text), false);
});

test('a location prompt can be edited, copied, restored, and follows a description change until it is edited', async () => {
  const copied = [];
  const { context, click, input } = appContext({ fetchImpl: planFetch(), clipboardImpl: async text => { copied.push(text); } });
  openStoryboard(context, roundTwoProject());
  await tick();
  input({ dataset: { entityPrompt: 'loc:loc-ruang' }, value: 'Ruang tamu versi malam, lampu hangat' });
  assert.equal(vm.runInContext("current.data.visualPrompts['loc:loc-ruang']", context), 'Ruang tamu versi malam, lampu hangat');
  await click({ copyEntity: 'loc:loc-ruang' });
  assert.equal(copied[0], 'Ruang tamu versi malam, lampu hangat');
  vm.runInContext("current.data.entities.locations[0].description='jendela besar'", context);
  await click({ copyEntity: 'loc:loc-ruang' });
  assert.equal(copied[1], 'Ruang tamu versi malam, lampu hangat', 'an edited prompt is kept after the description changes');
  await click({ resetPrompt: 'loc:loc-ruang' });
  assert.equal(vm.runInContext("'loc:loc-ruang' in current.data.visualPrompts", context), false);
  await click({ copyEntity: 'loc:loc-ruang' });
  assert.match(copied[2], /Suasana dan detail: jendela besar/, 'restoring the default uses the current description');
});

test('a product has a default Gemini prompt that keeps its form and label, and its prompt can be edited and restored', async () => {
  const copied = [];
  const p = roundTwoProject();
  p.data.assets = [{ id: 'p1', name: 'kopi.png', url: '/uploads/p1.png', type: 'Produk', entityKind: 'products', entityId: 'prod-kopi', label: 'utama' }];
  const { context, element, click, input } = appContext({ fetchImpl: planFetch(), clipboardImpl: async text => { copied.push(text); } });
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /data-entity-prompt="prod:prod-kopi"/);
  assert.match(html, /data-copy-entity="prod:prod-kopi"/);
  await click({ copyEntity: 'prod:prod-kopi' });
  assert.match(copied[0], /Produk: Kopi kemasan/);
  assert.match(copied[0], /Deskripsi: kemasan biru, tutup emas/);
  assert.match(copied[0], /bentuk, warna, proporsi, kemasan, label, dan detail merek/);
  assert.match(copied[0], /Referensi yang sudah ada untuk produk ini: Tampilan utama \(kopi\.png\)/);
  input({ dataset: { entityPrompt: 'prod:prod-kopi' }, value: 'Kopi kemasan, label dari gambar acuan' });
  await click({ copyEntity: 'prod:prod-kopi' });
  assert.equal(copied[1], 'Kopi kemasan, label dari gambar acuan');
  await click({ resetPrompt: 'prod:prod-kopi' });
  await click({ copyEntity: 'prod:prod-kopi' });
  assert.match(copied[2], /Produk: Kopi kemasan/, 'restoring brings back the default prompt');
});

test('the storyboard lists which saved images to attach in Gemini, and only for the linked characters, location and products', async () => {
  const p = roundTwoProject();
  p.data.assets = [
    { id: 'c1', name: 'wajah.png', url: '/uploads/c1.png', type: 'Karakter', entityKind: 'characters', entityId: 'char-rani', label: 'wajah' },
    { id: 'l1', name: 'ruang.png', url: '/uploads/l1.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-ruang', label: 'utama' },
    { id: 'l2', name: 'dapur.png', url: '/uploads/l2.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-dapur', label: 'utama' },
  ];
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /Lampirkan di Gemini/);
  assert.match(html, /<b>Karakter Rani<\/b>: lampirkan Wajah \(1 gambar\)/);
  assert.match(html, /<b>Lokasi Ruang tamu<\/b>: lampirkan Tampilan utama \(1 gambar\)/);
  assert.match(html, /<b>Produk Kopi kemasan<\/b>: belum ada gambar referensi/);
  assert.equal(/Dapur/.test(html.slice(html.indexOf('Lampirkan di Gemini'), html.indexOf('Prompt gambar'))), false, 'the unlinked location is not listed for attachment');
});

test('an older project without visual prompts opens with default location and product prompts', async () => {
  const p = roundTwoProject();
  delete p.data.visualPrompts;
  delete p.data.visualState;
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  assert.match(element('#tab-content').innerHTML, /data-entity-prompt="loc:loc-dapur"/);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(current.data.visualPrompts)', context)), {});
});

// Round 3 of Mode 1: storyboard summary, separate video prompt, Google Flow package.
const twoSceneProject = () => {
  const p = roundTwoProject();
  p.data.scenes.push({ id: 's2', title: 'Di dapur', purpose: 'Rani mencari kopi', visual: 'Dapur kosong', action: 'Rani membuka lemari', expression: 'fokus', location: 'Dapur', time: 'pagi', camera: 'close-up', cameraAngle: 'dari atas', cameraMovement: 'pan pelan', lighting: 'dingin', duration: '4 detik', characterIds: [], locationId: 'loc-dapur', productIds: [], referenceAssetIds: [], assetIds: [], productionChecklist: {}, approvalStatus: 'draft', production: 'Draft' });
  return p;
};
const sceneHtml = (html, index) => html.split('<article class="scene-card"')[index + 1] || '';

test('each scene card shows only its own storyboard image, and a placeholder when it has none', async () => {
  const p = twoSceneProject();
  p.data.assets = [
    { id: 'img-s1', name: 'adegan1.png', url: '/uploads/adegan1.png', type: 'Adegan', sceneId: 's1', referenceAssetIds: undefined },
    { id: 'a-rani', name: 'wajah.png', url: '/uploads/wajah.png', type: 'Karakter', entityKind: 'characters', entityId: 'char-rani', label: 'wajah' },
  ];
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  const first = sceneHtml(html, 0), second = sceneHtml(html, 1);
  assert.match(first, /<img class="scene-thumb" src="\/uploads\/adegan1\.png"/, 'scene 1 shows its own storyboard image');
  assert.equal(/wajah\.png/.test(first.slice(0, first.indexOf('Langkah berikutnya'))), false, 'a character reference is never used as the storyboard thumbnail');
  assert.equal(/adegan1\.png|src="\/uploads/.test(second.slice(0, second.indexOf('Langkah berikutnya'))), false, 'scene 2 does not show scene 1 image');
  assert.match(second, /Belum ada gambar storyboard/, 'scene 2 shows a clear placeholder');
  assert.match(first, /data-thumb/, 'the thumbnail can be replaced by a missing-file note');
});

test('the scene summary lists the linked character, location, product, and shot details', async () => {
  const p = twoSceneProject();
  p.data.assets = [{ id: 'l-ruang', name: 'ruang.png', url: '/uploads/ruang.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-ruang', label: 'utama' }];
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  const first = sceneHtml(element('#tab-content').innerHTML, 0);
  const summary = first.slice(first.indexOf('scene-summary'), first.indexOf('Langkah berikutnya'));
  assert.match(summary, /<dt>Tokoh<\/dt><dd>Rani<\/dd>/);
  assert.match(summary, /<dt>Lokasi<\/dt><dd>Ruang tamu<\/dd>/);
  assert.match(summary, /<dt>Produk<\/dt><dd>Kopi kemasan<\/dd>/);
  assert.match(summary, /<dt>Status gambar<\/dt><dd>Prompt siap<\/dd>/);
  assert.match(summary, /<dt>Prompt video<\/dt><dd>belum disalin<\/dd>/);
});

test('the next step asks for missing references first, then the Flow prompt, and a storyboard image is optional', async () => {
  const p = twoSceneProject();
  p.data.assets = [];
  const { context, element, click } = appContext({ fetchImpl: planFetch(), clipboardImpl: async () => {} });
  openStoryboard(context, p);
  await tick();
  assert.match(sceneHtml(element('#tab-content').innerHTML, 0), /Buat atau unggah ulang referensi untuk Rani di bagian Lembar karakter/);
  p.data.assets = [
    { id: 'a-rani', name: 'wajah.png', url: '/uploads/wajah.png', type: 'Karakter', entityKind: 'characters', entityId: 'char-rani', label: 'wajah' },
    { id: 'l-ruang', name: 'ruang.png', url: '/uploads/ruang.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-ruang', label: 'utama' },
    { id: 'p-kopi', name: 'kopi.png', url: '/uploads/kopi.png', type: 'Produk', entityKind: 'products', entityId: 'prod-kopi', label: 'utama' },
  ];
  vm.runInContext("assetFileState.set('/uploads/wajah.png','ok');assetFileState.set('/uploads/ruang.png','ok');assetFileState.set('/uploads/kopi.png','ok')", context);
  openStoryboard(context, p);
  await tick();
  assert.match(sceneHtml(element('#tab-content').innerHTML, 0), /Periksa prompt video, salin, lalu buka Google Flow\./, 'without a storyboard image the next step is the Flow prompt');
  await click({ copyEntity: 'video:s1' });
  assert.match(sceneHtml(element('#tab-content').innerHTML, 0), /Prompt video<\/dt><dd>sudah disalin/);
  assert.match(sceneHtml(element('#tab-content').innerHTML, 0), /Buka paket Google Flow, periksa kesiapan, lalu tandai sedang dikerjakan/);
});

test('the video prompt describes motion and camera, is kept separate from the image prompt, and can be edited and copied', async () => {
  const copied = [];
  const p = twoSceneProject();
  const { context, element, click, input } = appContext({ fetchImpl: planFetch(), clipboardImpl: async text => { copied.push(text); } });
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /data-entity-prompt="video:s1"/, 'the video prompt is editable');
  assert.match(html, /Prompt video untuk Google Flow/);
  assert.match(html, /href="https:\/\/labs\.google\/fx\/tools\/flow"[^>]*>Buka Google Flow/);
  await click({ copyEntity: 'video:s1' });
  assert.match(copied[0], /Aksi utama: Rani membuka pintu/);
  assert.match(copied[0], /Gerakan kamera: diam atau bergerak pelan, sesuai aksi\./);
  assert.match(copied[0], /Durasi klip: 5 detik/);
  assert.notEqual(copied[0], vm.runInContext("scenePrompt(current.data.scenes[0], current.data)", context), 'the video prompt is not the image prompt');
  input({ dataset: { entityPrompt: 'video:s1' }, value: 'Rani berjalan ke pintu, lalu berhenti.' });
  assert.equal(vm.runInContext("current.data.visualPrompts['video:s1']", context), 'Rani berjalan ke pintu, lalu berhenti.');
  await click({ copyEntity: 'video:s1' });
  assert.equal(copied[1], 'Rani berjalan ke pintu, lalu berhenti.');
  await click({ resetPrompt: 'video:s1' });
  assert.equal(vm.runInContext("'video:s1' in current.data.visualPrompts", context), false, 'restoring removes the edit');
});

test('a Gemini production clip is mapped manually and contributes to one final scene prompt', async () => {
  const p = twoSceneProject();
  p.data.productionPackage = savedView(samplePackage());
  p.data.scenes[0].productionClipIndex = 2;
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  const html = sceneBlock(context, element, 0);
  assert.match(html, /data-gemini-clip="s1"/);
  assert.match(html, /value="2" selected/);
  const prompt = vm.runInContext("sceneVideoPromptDefault(current.data.scenes[0], current.data)", context);
  assert.match(prompt, /Arahan inti dari paket produksi Gemini \\(klip 2\\): Tangan menuang kopi, uap naik\\./);
  assert.match(prompt, /Jika arahan inti ini berbeda dengan detail storyboard di bawah, ikuti detail storyboard sebagai keputusan final\\./);
  assert.match(prompt, /Aksi utama: Rani membuka pintu/);
  assert.match(prompt, /Durasi klip: 5 detik/);
  assert.equal(prompt.includes('Arahan inti dari paket produksi Gemini (klip 1)'), false);
});

test('the Google Flow package lists only the references linked to that scene, with their availability', async () => {
  const p = twoSceneProject();
  p.data.assets = [
    { id: 'a-rani', name: 'wajah.png', url: '/uploads/wajah.png', type: 'Karakter', entityKind: 'characters', entityId: 'char-rani', label: 'wajah' },
    { id: 'l-dapur', name: 'dapur.png', url: '/uploads/dapur.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-dapur', label: 'utama' },
    { id: 'l-ruang', name: 'ruang.png', url: '/uploads/ruang.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-ruang', label: 'utama' },
  ];
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  const [one, two] = [sceneHtml(element('#tab-content').innerHTML, 0), sceneHtml(element('#tab-content').innerHTML, 1)];
  const packageOne = one.slice(one.indexOf('flow-package'));
  const packageTwo = two.slice(two.indexOf('flow-package'));
  assert.match(packageOne, /<b>Karakter: Rani<\/b> · wajah\.png — belum dapat dipastikan/, 'a file that is not yet checked is not called ready');
  assert.match(packageOne, /<b>Lokasi: Ruang tamu<\/b> · ruang\.png — belum dapat dipastikan/);
  assert.match(packageOne, /<b>Produk: Kopi kemasan<\/b> · belum ada gambar referensi/, 'a product without images says so');
  assert.equal(/dapur\.png|Dapur/.test(packageOne), false, 'the other location is not in scene 1');
  assert.match(packageTwo, /<b>Lokasi: Dapur<\/b> · dapur\.png — belum dapat dipastikan/);
  assert.equal(/wajah\.png/.test(packageTwo), false, 'the character is not in scene 2');
  assert.match(packageOne, /Belum dapat dipastikan keberadaannya: wajah\.png, ruang\.png\./);
  assert.equal(/File siap diunggah manual di Flow/.test(packageOne), false, 'nothing is ready before the check finishes');
});

test('a scene with no linked references says so in the Flow package and in the summary', async () => {
  const p = twoSceneProject();
  p.data.scenes[0].characterIds = [];
  p.data.scenes[0].locationId = '';
  p.data.scenes[0].productIds = [];
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /Belum ada karakter, lokasi, atau produk yang tertaut ke adegan ini\./);
  assert.match(html, /Belum ada file yang siap diunggah/);
});

test('the image prompt names the shot and camera angle, and the video prompt names the camera movement', async () => {
  const copied = [];
  const { context, click } = appContext({ fetchImpl: planFetch(), clipboardImpl: async text => { copied.push(text); } });
  openStoryboard(context, twoSceneProject());
  await tick();
  await click({ copyScene: 's2' });
  assert.match(copied[0], /Kamera: close-up/);
  assert.match(copied[0], /Sudut kamera: dari atas/);
  assert.equal(/Gerakan kamera/.test(copied[0]), false, 'a still image prompt does not describe movement');
  await click({ copyEntity: 'video:s2' });
  assert.match(copied[1], /Gerakan kamera: pan pelan\./);
  assert.match(copied[1], /Sudut kamera: dari atas\./);
});

test('an older scene without the new camera fields or prompt store still opens, and shows the new fields empty', async () => {
  const p = twoSceneProject();
  delete p.data.visualPrompts;
  delete p.data.visualState;
  delete p.data.scenes[0].cameraAngle;
  delete p.data.scenes[0].cameraMovement;
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /data-field="cameraAngle" value=""/);
  assert.match(html, /data-field="cameraMovement" value=""/);
  assert.match(html, /data-entity-prompt="video:s1"/);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(current.data.visualPrompts)', context)), {});
});

// Round 3 fixes: file status is only "ready" once the file is confirmed, the summary and next step report missing files,
// legacy camera text stays in the camera field, and both prompts explain themselves.
test('a Flow file is called ready only when confirmed; missing and unchecked files are listed separately', async () => {
  const p = twoSceneProject();
  p.data.assets = [
    { id: 'a-rani', name: 'wajah.png', url: '/uploads/wajah.png', type: 'Karakter', entityKind: 'characters', entityId: 'char-rani', label: 'wajah' },
    { id: 'l-ruang', name: 'ruang.png', url: '/uploads/ruang.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-ruang', label: 'utama' },
  ];
  const { context, element } = appContext({ fetchImpl: planFetch() });
  vm.runInContext("assetFileState.set('/uploads/ruang.png','ok');assetFileState.set('/uploads/wajah.png','missing')", context);
  openStoryboard(context, p);
  await tick();
  const pkg = element('#tab-content').innerHTML.slice(element('#tab-content').innerHTML.indexOf('flow-package'));
  assert.match(pkg, /<b>Lokasi: Ruang tamu<\/b> · ruang\.png — siap diunggah/);
  assert.match(pkg, /<b>Karakter: Rani<\/b> · wajah\.png — file tidak ditemukan; unggah ulang/);
  assert.match(pkg, /File siap diunggah manual di Flow: ruang\.png\./);
  assert.match(pkg, /File tidak ditemukan: wajah\.png\./);
  assert.equal(/File siap diunggah manual di Flow: [^.]*wajah/.test(pkg), false, 'a missing file is never listed as ready');
});

test('a missing storyboard file is reported in the summary and as the next step', async () => {
  const p = twoSceneProject();
  p.data.assets = [
    { id: 'img-s1', name: 'adegan1.png', url: '/uploads/adegan1.png', type: 'Adegan', sceneId: 's1' },
    { id: 'a-rani', name: 'wajah.png', url: '/uploads/wajah.png', type: 'Karakter', entityKind: 'characters', entityId: 'char-rani', label: 'wajah' },
    { id: 'l-ruang', name: 'ruang.png', url: '/uploads/ruang.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-ruang', label: 'utama' },
    { id: 'p-kopi', name: 'kopi.png', url: '/uploads/kopi.png', type: 'Produk', entityKind: 'products', entityId: 'prod-kopi', label: 'utama' },
  ];
  const { context, element } = appContext({ fetchImpl: planFetch() });
  vm.runInContext("assetFileState.set('/uploads/adegan1.png','missing');assetFileState.set('/uploads/wajah.png','ok');assetFileState.set('/uploads/ruang.png','ok');assetFileState.set('/uploads/kopi.png','ok')", context);
  openStoryboard(context, p);
  await tick();
  const first = sceneHtml(element('#tab-content').innerHTML, 0);
  assert.match(first, /<dt>Status gambar<\/dt><dd>Gambar adegan tidak ditemukan<\/dd>/);
  assert.match(first, /Gambar adegan tidak ditemukan; unggah ulang di bagian Gambar adegan\./);
});

test('a checked-but-unknown file is not shown as ready in the summary', async () => {
  const p = twoSceneProject();
  p.data.assets = [{ id: 'img-s1', name: 'adegan1.png', url: '/uploads/adegan1.png', type: 'Adegan', sceneId: 's1' }];
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  const first = sceneHtml(element('#tab-content').innerHTML, 0);
  assert.equal(/siap diunggah/.test(first), false);
  assert.match(first, /Belum dapat dipastikan keberadaannya: adegan1\.png/);
  assert.match(first, /<dt>Status gambar<\/dt><dd>Gambar adegan sedang diperiksa<\/dd>/, 'the summary does not claim the image is ready');
});

test('an old scene camera value stays under the camera label and is not read as a shot or a movement', async () => {
  const copied = [];
  const p = twoSceneProject();
  p.data.scenes[0].camera = 'dolly pelan ke depan';
  delete p.data.scenes[0].cameraMovement;
  const { context, element, click } = appContext({ fetchImpl: planFetch(), clipboardImpl: async text => { copied.push(text); } });
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /<label>Framing \/ gerak kamera<textarea data-field="camera">dolly pelan ke depan<\/textarea>/, 'the old value keeps its original label');
  assert.equal(/Jenis shot/.test(html), false, 'no field is renamed to shot');
  await click({ copyEntity: 'video:s1' });
  assert.match(copied[0], /Catatan kamera dari adegan: dolly pelan ke depan\./);
  assert.match(copied[0], /Gerakan kamera: diam atau bergerak pelan, sesuai aksi\./, 'the movement line is not filled from the old value');
});

test('the tab 05 prompt and the Google Flow package each say what their prompt is for, and tab 05 still works', async () => {
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, twoSceneProject());
  await tick();
  assert.match(element('#tab-content').innerHTML, /khusus Google Flow/, 'the storyboard explains the Flow prompt');
  vm.runInContext("activeTab='prompt';renderProject()", context);
  await tick();
  const prompt = element('#tab-content').innerHTML;
  assert.match(prompt, /Prompt di tab ini adalah prompt umum/, 'tab 05 explains its own prompt');
  assert.match(prompt, /id="copy-prompt"/, 'tab 05 keeps its copy button');
  assert.match(prompt, /id="prompt-text"/, 'tab 05 keeps its editable prompt');
});

test('a storyboard image with a non-upload address is shown the same way in the thumbnail, summary, and Flow list', async () => {
  const p = twoSceneProject();
  p.data.assets = [{ id: 'img-s1', name: 'adegan1.png', url: '/files/adegan1.png', type: 'Adegan', sceneId: 's1' }];
  const { context, element } = appContext({ fetchImpl: planFetch() });
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  const first = sceneHtml(html, 0), second = sceneHtml(html, 1);
  assert.equal(/Belum ada gambar storyboard/.test(first), false, 'a stored image that is not usable is not described as absent');
  assert.match(first, /<b>Gambar adegan tidak ditemukan<\/b>/, 'the thumbnail says the image is missing');
  assert.match(first, /<dt>Status gambar<\/dt><dd>Gambar adegan tidak ditemukan<\/dd>/, 'the summary agrees');
  assert.match(first, /<b>Gambar adegan<\/b> · adegan1\.png — file tidak ditemukan; unggah ulang/, 'the Flow list agrees');
  assert.doesNotMatch(first, /<img class="scene-thumb"/, 'no broken image is rendered');
  assert.match(second, /Belum ada gambar storyboard/, 'a scene with no stored image still shows the absent placeholder');
});

test('when a scene has one usable and one unusable storyboard image, the thumbnail uses the usable one', async () => {
  const p = twoSceneProject();
  p.data.assets = [
    { id: 'img-bad', name: 'lama.png', url: '/files/lama.png', type: 'Adegan', sceneId: 's1' },
    { id: 'img-ok', name: 'baru.png', url: '/uploads/baru.png', type: 'Adegan', sceneId: 's1' },
  ];
  const { context, element } = appContext({ fetchImpl: planFetch() });
  vm.runInContext("assetFileState.set('/uploads/baru.png','ok')", context);
  openStoryboard(context, p);
  await tick();
  const first = sceneHtml(element('#tab-content').innerHTML, 0);
  assert.match(first, /<img class="scene-thumb" src="\/uploads\/baru\.png"/);
  assert.equal(/lama\.png/.test(first.slice(0, first.indexOf('Langkah berikutnya'))), false, 'the unusable image is not the thumbnail');
  assert.match(first, /<dt>Status gambar<\/dt><dd>Referensi visual tersedia<\/dd>/, 'the summary reports the usable image');
  assert.match(first, /Gambar adegan<\/b> · lama\.png — file tidak ditemukan/, 'the unusable image is still listed as missing');
});

// Round 4: production status, readiness, video results, and project summary.
const ready = (d, ids) => vm.runInContext(`${ids.map(id => `assetFileState.set('${id}','ok')`).join(';')}`, d);
const videoFetch = ({ posts = [], puts = [], postReply, putReply, deny = null } = {}) => async (url, options) => {
  if (options?.method === 'POST' && url.endsWith('/video-results')) { posts.push({ url, headers: options.headers, bytes: options.body }); return postReply ? postReply() : response({}); }
  if (options?.method === 'PUT' && url.includes('/video-results/')) { puts.push({ url, body: JSON.parse(options.body) }); return putReply ? putReply() : response({}); }
  if (options?.method === 'PUT') return response(JSON.parse(options.body));
  return planFetch()(url, options);
};
const sceneBlock = (context, element, index) => sceneHtml(element('#tab-content').innerHTML, index);
const linkedScene = () => {
  const p = twoSceneProject();
  p.data.assets = [
    { id: 'a-rani', name: 'wajah.png', url: '/uploads/wajah.png', type: 'Karakter', entityKind: 'characters', entityId: 'char-rani', label: 'wajah' },
    { id: 'l-ruang', name: 'ruang.png', url: '/uploads/ruang.png', type: 'Lokasi', entityKind: 'locations', entityId: 'loc-ruang', label: 'utama' },
    { id: 'p-kopi', name: 'kopi.png', url: '/uploads/kopi.png', type: 'Produk', entityKind: 'products', entityId: 'prod-kopi', label: 'utama' },
  ];
  return p;
};
const resultFor = (id, scene, status = 'kandidat', extra = {}) => ({ id, sceneId: scene, name: `${id}.mp4`, url: `/uploads/${id}.mp4`, type: 'video/mp4', size: 1000000, addedAt: '2026-01-0' + (id.length) + 'T10:00:00+00:00', note: '', status, ...extra });

test('a scene shows Belum siap until its required references exist, then Siap diproduksi, then Sedang dikerjakan when marked', async () => {
  const p = twoSceneProject();
  const { context, element, click } = appContext({ fetchImpl: videoFetch(), clipboardImpl: async () => {} });
  openStoryboard(context, p);
  await tick();
  assert.match(sceneBlock(context, element, 0), /<dt>Status produksi<\/dt><dd>Belum siap<\/dd>/);
  p.data.assets = linkedScene().data.assets;
  ready(context, ['/uploads/wajah.png', '/uploads/ruang.png', '/uploads/kopi.png']);
  openStoryboard(context, p);
  await tick();
  assert.match(sceneBlock(context, element, 0), /<dt>Status produksi<\/dt><dd>Siap diproduksi<\/dd>/);
  await click({ copyEntity: 'video:s1' });
  assert.match(sceneBlock(context, element, 0), /<dt>Status produksi<\/dt><dd>Siap diproduksi<\/dd>/, 'copying the prompt does not mean a video exists');
  await click({ flowStart: 's1' });
  assert.match(sceneBlock(context, element, 0), /<dt>Status produksi<\/dt><dd>Sedang dikerjakan<\/dd>/);
  assert.match(sceneBlock(context, element, 0), /Batalkan tanda sedang dikerjakan/);
  await click({ flowStart: 's1' });
  assert.match(sceneBlock(context, element, 0), /<dt>Status produksi<\/dt><dd>Siap diproduksi<\/dd>/, 'the manual mark can be removed');
});

test('the readiness check names what is missing and what the user must do, and a storyboard image is optional', async () => {
  const p = twoSceneProject();
  p.data.scenes[0].action = '';
  p.data.scenes[0].purpose = '';
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  openStoryboard(context, p);
  await tick();
  const first = sceneBlock(context, element, 0);
  assert.match(first, /Kesiapan: Belum lengkap/);
  assert.match(first, /<b>Informasi adegan<\/b> · Belum lengkap: isi aksi atau tujuan adegan/);
  assert.match(first, /<b>Karakter Rani<\/b> · Perlu tindakan pengguna: belum ada referensi/);
  assert.match(first, /<b>Gambar storyboard<\/b> · Siap: tidak dipakai \(opsional\)/);
});

test('a missing reference file is reported as File tidak ditemukan in the readiness check, not as ready', async () => {
  const p = linkedScene();
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  vm.runInContext("assetFileState.set('/uploads/wajah.png','missing');assetFileState.set('/uploads/ruang.png','ok');assetFileState.set('/uploads/kopi.png','ok')", context);
  openStoryboard(context, p);
  await tick();
  const first = sceneBlock(context, element, 0);
  assert.match(first, /Kesiapan: File tidak ditemukan/);
  assert.match(first, /<b>Karakter Rani<\/b> · File tidak ditemukan/);
  assert.match(first, /<dt>Status produksi<\/dt><dd>Belum siap<\/dd>/);
});

test('uploading a video saves it as a new result for that scene and shows its name and status', async () => {
  const posts = [];
  const result = resultFor('r1', 's1', 'kandidat', { addedAt: '2026-01-01T10:00:00+00:00' });
  const { context, element, change } = appContext({ fetchImpl: videoFetch({ posts, postReply: () => response({ result, videoResults: [result] }) }) });
  openStoryboard(context, linkedScene());
  await tick();
  change({ dataset: { resultUpload: 's1' }, files: [{ name: 'r1.mp4', type: 'video/mp4', size: 1000000 }] });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers['X-Scene-Id'], 's1');
  assert.equal(posts[0].headers['Content-Type'], 'video/mp4');
  const html = sceneBlock(context, element, 0);
  assert.match(html, /Hasil 1: r1\.mp4/);
  assert.match(html, /<span class="result-status result-kandidat">Kandidat<\/span>/);
  assert.match(html, /<video class="result-video" controls preload="metadata" src="\/uploads\/r1\.mp4" data-result-video="r1"><\/video>/);
  assert.match(html, /<dt>Hasil video<\/dt><dd>1 hasil \(belum ada hasil utama\)<\/dd>/);
});

test('a video in the wrong format or over the size limit is refused before any upload, and a failed upload is not shown as saved', async () => {
  const posts = [];
  const { context, element, change } = appContext({ fetchImpl: videoFetch({ posts, postReply: () => ({ ok: false, status: 415, json: async () => ({ error: 'Format video harus MP4 atau WebM.' }) }) }) });
  openStoryboard(context, linkedScene());
  await tick();
  change({ dataset: { resultUpload: 's1' }, files: [{ name: 'gambar.png', type: 'image/png', size: 1000 }] });
  change({ dataset: { resultUpload: 's1' }, files: [{ name: 'besar.mp4', type: 'video/mp4', size: 50_000_001 }] });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(posts.length, 0, 'refused client-side');
  change({ dataset: { resultUpload: 's1' }, files: [{ name: 'rusak.mp4', type: 'video/mp4', size: 1000 }] });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(posts.length, 1);
  assert.equal(/Hasil 1: rusak\.mp4/.test(sceneBlock(context, element, 0)), false, 'a failed upload is not listed as a result');
  assert.match(sceneBlock(context, element, 0), /Belum ada hasil video untuk adegan ini\./);
});

test('several results for one scene are kept; choosing a main result demotes the previous one only for that scene', async () => {
  const puts = [];
  const r1 = resultFor('r1', 's1', 'utama', { addedAt: '2026-01-01T10:00:00+00:00' });
  const r2 = resultFor('r2', 's1', 'kandidat', { addedAt: '2026-01-02T10:00:00+00:00' });
  const other = resultFor('r3', 's2', 'utama', { addedAt: '2026-01-03T10:00:00+00:00' });
  const demoted = [{ ...r1, status: 'kandidat' }, { ...r2, status: 'utama' }, other];
  const { context, element, click } = appContext({ fetchImpl: videoFetch({ puts, putReply: () => response({ result: { ...r2, status: 'utama' }, videoResults: demoted }) }) });
  const p = linkedScene();
  p.data.videoResults = [r1, r2, other];
  openStoryboard(context, p);
  await tick();
  const before = sceneBlock(context, element, 0);
  assert.match(before, /Hasil 1: r1\.mp4/);
  assert.match(before, /Hasil 2: r2\.mp4/);
  assert.equal(/r3\.mp4/.test(before), false, 'a result of another scene is not shown here');
  await click({ resultStatus: 'utama', resultId: 'r2' });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, { status: 'utama' });
  const after = sceneBlock(context, element, 0);
  assert.match(after, /<span class="result-status result-utama">Hasil utama<\/span>/);
  assert.match(after, /<span class="result-status result-kandidat">Kandidat<\/span>/);
  assert.match(after, /<dt>Hasil utama<\/dt><dd>r2\.mp4<\/dd>/);
  assert.match(after, /<dt>Status produksi<\/dt><dd>Hasil video tersedia<\/dd>/);
});

test('a failed status change keeps the previous state and reports the problem', async () => {
  const r1 = resultFor('r1', 's1', 'kandidat');
  const { context, element, click } = appContext({ fetchImpl: videoFetch({ putReply: () => ({ ok: false, status: 404, json: async () => ({ error: 'Hasil video tidak ditemukan' }) }) }) });
  const p = linkedScene();
  p.data.videoResults = [r1];
  openStoryboard(context, p);
  await tick();
  await click({ resultStatus: 'utama', resultId: 'r1' });
  for (let i = 0; i < 4; i++) await tick();
  assert.match(sceneBlock(context, element, 0), /<span class="result-status result-kandidat">Kandidat<\/span>/);
});

test('a revision note is saved with its result, and a revised result is shown as Perlu revisi', async () => {
  const puts = [];
  const r1 = resultFor('r1', 's1', 'kandidat');
  const { context, element, change, click } = appContext({ fetchImpl: videoFetch({ puts, putReply: () => response({ result: {}, videoResults: [{ ...r1, note: 'wajah terlalu gelap', status: 'revisi' }] }) }) });
  const p = linkedScene();
  p.data.videoResults = [r1];
  openStoryboard(context, p);
  await tick();
  change({ dataset: { resultNoteInput: 'r1' }, value: 'wajah terlalu gelap' });
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(puts[0].body, { note: 'wajah terlalu gelap' });
  await click({ resultStatus: 'revisi', resultId: 'r1' });
  for (let i = 0; i < 4; i++) await tick();
  const html = sceneBlock(context, element, 0);
  assert.match(html, /<span class="result-status result-revisi">Perlu revisi<\/span>/);
  assert.match(html, /<dt>Status produksi<\/dt><dd>Perlu revisi<\/dd>/);
});

test('a result whose file is gone shows a clear message instead of a video, and does not count as a result', async () => {
  const r1 = resultFor('r9', 's1', 'utama');
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  vm.runInContext("assetFileState.set('/uploads/r9.mp4','missing')", context);
  const p = linkedScene();
  p.data.videoResults = [r1];
  openStoryboard(context, p);
  await tick();
  const html = sceneBlock(context, element, 0);
  assert.match(html, /File tidak ditemukan\. Unggah ulang video ini sebagai hasil baru\./);
  assert.equal(/data-result-video="r9"/.test(html), false, 'no broken video is rendered');
  assert.match(html, /<dt>Status produksi<\/dt><dd>Belum siap<\/dd>/, 'a missing result is not a finished result');
  assert.match(html, /<dt>Hasil utama<\/dt><dd>belum dipilih<\/dd>/);
});

test('the storyboard summary counts each scene once and agrees with the status of each scene', async () => {
  const p = linkedScene();
  p.data.videoResults = [resultFor('r1', 's1', 'utama')];
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  vm.runInContext("assetFileState.set('/uploads/r1.mp4','ok')", context);
  openStoryboard(context, p);
  await tick();
  const summary = element('#tab-content').innerHTML;
  assert.match(summary, /<b>Produksi 2 adegan:<\/b> <span>Belum siap 1<\/span> · <span>Siap diproduksi 0<\/span> · <span>Sedang dikerjakan 0<\/span> · <span>Hasil video 1<\/span> · <span>Perlu revisi 0<\/span>/);
});

test('an older project without results, flow marks, or readiness data still opens and shows empty results', async () => {
  const p = twoSceneProject();
  delete p.data.videoResults;
  for (const s of p.data.scenes) delete s.flowStartedAt;
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  openStoryboard(context, p);
  await tick();
  const html = sceneBlock(context, element, 0);
  assert.match(html, /Belum ada hasil video untuk adegan ini\./);
  assert.match(html, /<dt>Status produksi<\/dt><dd>Belum siap<\/dd>/);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(current.data.videoResults)', context)), []);
});

test('the storyboard tab and the Flow package explain the manual steps without claiming a video was made', async () => {
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  openStoryboard(context, linkedScene());
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /Aplikasi tidak membuat video/);
  assert.match(html, /Tandai sedang dikerjakan di Flow/);
  assert.equal(/video sudah dibuat|video dibuat otomatis/i.test(html), false);
});

// Round 4 (second pass): checklist and saved results must not contradict each other.
test('a scene marked as generated in the checklist, with no saved file, says the file is not in the app yet', async () => {
  const p = linkedScene();
  p.data.checks = { 'scene-s1-generated': true };
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  vm.runInContext("assetFileState.set('/uploads/wajah.png','ok');assetFileState.set('/uploads/ruang.png','ok');assetFileState.set('/uploads/kopi.png','ok')", context);
  openStoryboard(context, p);
  await tick();
  const html = sceneBlock(context, element, 0);
  assert.match(html, /<dt>Checklist<\/dt><dd>Klip dibuat menurut checklist, tetapi file hasil belum tersedia di aplikasi\.<\/dd>/);
  assert.match(html, /<dt>Status produksi<\/dt><dd>Siap diproduksi<\/dd>/, 'the checklist claim does not change the production status');
  assert.equal(/Hasil video tersedia/.test(html), false);
});

test('a checklist claim with a saved and visible file agrees with the production status', async () => {
  const p = linkedScene();
  p.data.checks = { 'scene-s1-generated': true };
  p.data.videoResults = [resultFor('r1', 's1', 'utama')];
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  vm.runInContext("assetFileState.set('/uploads/r1.mp4','ok')", context);
  openStoryboard(context, p);
  await tick();
  const html = sceneBlock(context, element, 0);
  assert.match(html, /<dt>Status produksi<\/dt><dd>Hasil video tersedia<\/dd>/);
  assert.equal(/belum tersedia di aplikasi|tidak ditemukan di aplikasi/.test(html), false, 'no contradiction is reported');
});

test('a collected checklist item whose file is missing never reads as saved', async () => {
  const p = linkedScene();
  p.data.checks = { 'scene-s1-collected': true };
  p.data.videoResults = [resultFor('r9', 's1', 'utama')];
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  vm.runInContext("assetFileState.set('/uploads/r9.mp4','missing')", context);
  openStoryboard(context, p);
  await tick();
  const html = sceneBlock(context, element, 0);
  assert.match(html, /Checklist &quot;Klip disimpan\/dikumpulkan&quot; dicentang, tetapi file hasil tidak ditemukan di aplikasi\.|Checklist "Klip disimpan\/dikumpulkan" dicentang, tetapi file hasil tidak ditemukan di aplikasi\./);
  assert.equal(/tersimpan di aplikasi/.test(html.replace(/belum tersimpan di aplikasi|tidak ditemukan di aplikasi/g, '')), false, 'the missing file is not described as saved');
});

test('a saved file that is not yet ticked in the checklist is reported as a question for the user, not as a conflict', async () => {
  const p = linkedScene();
  p.data.videoResults = [resultFor('r1', 's1', 'kandidat')];
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  vm.runInContext("assetFileState.set('/uploads/r1.mp4','ok')", context);
  openStoryboard(context, p);
  await tick();
  assert.match(sceneBlock(context, element, 0), /Hasil video tersimpan di aplikasi, tetapi checklist &quot;Klip dibuat di platform eksternal&quot; belum dicentang\.|Hasil video tersimpan di aplikasi, tetapi checklist "Klip dibuat di platform eksternal" belum dicentang\./);
});

test('the project summary warns about checklist claims without files and explains where the header status comes from', async () => {
  const p = twoSceneProject();
  p.data.checks = { 'scene-s1-generated': true, 'scene-s2-collected': true };
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  openStoryboard(context, p);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /1 adegan ditandai &quot;Klip dibuat&quot; di checklist, tetapi file hasilnya belum tersimpan di aplikasi\.|1 adegan ditandai "Klip dibuat" di checklist, tetapi file hasilnya belum tersimpan di aplikasi\./);
  assert.match(html, /1 adegan ditandai "Klip disimpan" di checklist|1 adegan ditandai &quot;Klip disimpan&quot; di checklist/);
  assert.match(html, /Status di bagian atas proyek berasal dari checklist manual\./);
});

test('the checklist tab shows, per scene, what the checklist says and what the app actually holds', async () => {
  const p = twoSceneProject();
  p.data.checks = { 'scene-s1-generated': true };
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  openStoryboard(context, p);
  await tick();
  vm.runInContext("activeTab='checklist';renderProject()", context);
  await tick();
  const html = element('#tab-content').innerHTML;
  assert.match(html, /Hasil di aplikasi: belum ada file tersimpan/);
  assert.match(html, /Klip dibuat menurut checklist, tetapi file hasil belum tersedia di aplikasi\./);
  assert.match(html, /data-check="scene-s1-generated"/, 'the manual checkbox is still there and unchanged');
});

test('ticking a manual checklist box does not turn a scene into a finished result', async () => {
  const p = linkedScene();
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  vm.runInContext("assetFileState.set('/uploads/wajah.png','ok');assetFileState.set('/uploads/ruang.png','ok');assetFileState.set('/uploads/kopi.png','ok')", context);
  openStoryboard(context, p);
  await tick();
  vm.runInContext("updateSceneChecklist(current.data,'scene-s1-generated',true)", context);
  openStoryboard(context, JSON.parse(vm.runInContext('JSON.stringify(current)', context)));
  await tick();
  const html = sceneBlock(context, element, 0);
  assert.match(html, /<dt>Status produksi<\/dt><dd>Siap diproduksi<\/dd>/);
  assert.equal(/Hasil video tersedia/.test(html), false);
});

test('a missing result cannot be chosen as the main result in the interface', async () => {
  const p = linkedScene();
  p.data.videoResults = [resultFor('r9', 's1', 'kandidat')];
  const { context, element } = appContext({ fetchImpl: videoFetch() });
  vm.runInContext("assetFileState.set('/uploads/r9.mp4','missing')", context);
  openStoryboard(context, p);
  await tick();
  assert.match(sceneBlock(context, element, 0), /data-result-status="utama" data-result-id="r9" disabled/);
});

test('the video upload limit is exactly 50 MB: the boundary is accepted and one byte more is refused before sending', async () => {
  const posts = [];
  const result = resultFor('r1', 's1', 'kandidat');
  const { context, change } = appContext({ fetchImpl: videoFetch({ posts, postReply: () => response({ result, videoResults: [result] }) }) });
  openStoryboard(context, linkedScene());
  await tick();
  change({ dataset: { resultUpload: 's1' }, files: [{ name: 'tepat.mp4', type: 'video/mp4', size: 50_000_000 }] });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(posts.length, 1, 'exactly 50 MB is accepted');
  change({ dataset: { resultUpload: 's1' }, files: [{ name: 'lebih.mp4', type: 'video/mp4', size: 50_000_001 }] });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(posts.length, 1, 'one byte more is refused without a request');
});
