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

function appContext({ fetchImpl, storageImpl, projects = [], confirmImpl } = {}) {
  const elements = new Map();
  const session = new Map();
  const handlers = {};
  let scrolls = 0;
  let confirms = 0;
  const confirmMessages = [];
  const makeElement = () => ({
    value: '', textContent: '', innerHTML: '', disabled: false, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
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
    navigator: { clipboard: { writeText: async () => {} } }, sessionStorage: storage,
    setTimeout: () => 1, clearTimeout() {}, confirm: message => { confirms++; confirmMessages.push(message); return confirmImpl ? confirmImpl(message) : true; }, prompt: () => null,
    fetch, console,
  });
  vm.runInContext(fs.readFileSync(require.resolve('../static/app.js'), 'utf8'), context);
  function click({ id, tab, view, open, deleteAsset, linkAll } = {}) {
    const target = {
      id, dataset: { deleteAsset, linkAll },
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
  assert.match(element('#toast').textContent, /Penyimpanan gagal/);
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
