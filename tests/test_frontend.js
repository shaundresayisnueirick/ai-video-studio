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
    navigator: { clipboard: { writeText: clipboardImpl || (async () => {}) } }, sessionStorage: storage,
    setTimeout: () => 1, clearTimeout() {}, confirm: message => { confirms++; confirmMessages.push(message); return confirmImpl ? confirmImpl(message) : true; }, prompt: () => null,
    fetch, console,
  });
  vm.runInContext(fs.readFileSync(require.resolve('../static/app.js'), 'utf8'), context);
  function click({ id, tab, view, open, deleteAsset, linkAll, copyClip, copyLang } = {}) {
    const target = {
      id, dataset: { deleteAsset, linkAll, copyClip, copyLang },
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
  assert.match(element('#toast').textContent, /Paket belum tersimpan: Gagal menyimpan paket produksi/);
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
  openPackageTab(context, p);
  await tick();
  assert.equal(element('#build-package').disabled, true);
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
  assert.match(element('#tab-content').innerHTML, /Pemahaman sudah dikonfirmasi/);
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
  assert.match(element('#tab-content').innerHTML, /Ide sudah berubah sejak pemahaman dikonfirmasi/);
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
  openPackageTab(context, p);
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
  openPackageTab(context, p);
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
  openPackageTab(context, p);
  await tick();
  await click({ id: 'confirm-understanding' });
  await tick();
  await tick();
  assert.match(element('#toast').textContent, /belum tersimpan/);
  assert.equal(vm.runInContext('current.data.understanding.status', context), 'draft');
  const failed = element('#tab-content').innerHTML;
  assert.equal(failed.includes('Pemahaman sudah dikonfirmasi'), false);
  assert.ok(failed.includes('id="confirm-understanding"'));
  assert.equal(element('#build-package').disabled, true, 'the package stays blocked');
  saveWorks = true;
  await click({ id: 'confirm-understanding' });
  await tick();
  assert.equal(vm.runInContext('current.data.understanding.status', context), 'confirmed');
  assert.match(element('#tab-content').innerHTML, /Pemahaman sudah dikonfirmasi/);
  assert.equal(puts[puts.length - 1].data.understanding.status, 'confirmed');
});
