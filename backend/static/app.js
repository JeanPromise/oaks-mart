// frontend/app.js (final)
// ES module version — no bundler required
import Dexie from 'https://unpkg.com/dexie@3.2.2/dist/dexie.mjs';

// ---------------- DB ----------------
const db = new Dexie('OaksMartDB');
db.version(2).stores({
  products: '++id,barcode,name,price,cost,qty,is_new,created_at',
  transactions: '++id,createdAt,total,lines,payment_type,synced,local_id',
  syncQueue: '++id,payload,attempts',
  users: '++id,name,is_admin,pin_hash'
});

// ---------------- DOM refs (guarded) ----------------
const $ = id => document.getElementById(id);
const video = $('video');
const scanToggle = $('scanToggle');
const scanResult = $('scanResult');
const productList = $('productList');
const cartList = $('cartList');
const cartTotal = $('cartTotal');
const checkoutBtn = $('checkoutBtn');
const addProductBtn = $('addProductBtn');
const productModal = $('productModal');
const productForm = $('productForm');
const exportCsv = $('exportCsv');
const exportPdf = $('exportPdf');
const searchInput = $('search');
const filterStock = $('filterStock');

const loginModal = $('loginModal');
const loginForm = $('loginForm');
const openLogin = $('openLogin');
const cancelLogin = $('cancelLogin');
const openCreateUser = $('openCreateUser');

// sync button may be named syncBtn or syncBtnTop in different html copies
const syncBtn = $('syncBtn') || $('syncBtnTop') || null;

let cart = [];
let stream = null;
let scanning = false;
let barcodeDetector = null;
let lastScanned = null;
let activeUser = null;

// ---------------- API_BASE detection (no hardcoding) ----------------
// Priority:
// 1) window.OAKS_API_BASE if set (useful for testing, e.g. in console)
// 2) If the page origin port is 5000 -> use page origin
// 3) Otherwise assume backend runs on same host + port 5000
// 4) If location.hostname is empty (file://), fallback to 'http://localhost:5000'
function detectApiBase(){
  if (window.OAKS_API_BASE) return window.OAKS_API_BASE.replace(/\/+$/,'');
  try {
    const proto = location.protocol === 'file:' ? 'http:' : location.protocol;
    const hostname = location.hostname || 'localhost';
    const port = location.port;
    if (port === '5000') return `${location.origin.replace(/\/+$/,'')}`;
    // If the page uses a non-standard port or none, try same host at :5000
    return `${proto}//${hostname}:5000`;
  } catch(e){
    return 'http://localhost:5000';
  }
}
const API_BASE = detectApiBase();

// ---------------- utilities ----------------
const money = n => Number(n || 0).toFixed(2);
const now = () => new Date().toISOString();

// Web Crypto helper to SHA-256 hash PIN (client-side storage)
async function hashPin(pin) {
  const enc = new TextEncoder();
  const data = enc.encode(pin);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map(b => b.toString(16).padStart(2,'0')).join('');
}

// ---------------- BarcodeDetector init ----------------
if ('BarcodeDetector' in window) {
  try {
    barcodeDetector = new BarcodeDetector({formats: ['ean_13','qr_code','code_128','ean_8']});
  } catch(e){
    console.warn('BarcodeDetector init error', e);
    barcodeDetector = null;
  }
}

// ZXing fallback loaded via CDN (index.html includes it)
const ZX = window.ZXing || null;

// ---------------- Robust scanner improvements ----------------
const overlay = $('overlay');
const overlayCtx = overlay && overlay.getContext ? overlay.getContext('2d') : null;

async function startScanner(){
  if (scanning) return;
  if (!video) return alert('Camera area not found in the HTML.');
  scanning = true;
  if (scanToggle) scanToggle.textContent = 'Stop Scanner';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } });
    video.srcObject = stream;
    await video.play();
    requestAnimationFrame(scanFrame);
  } catch (err) {
    alert('Camera error: ' + (err.message || err));
    scanning = false;
    if (scanToggle) scanToggle.textContent = 'Start Scanner';
  }
}

function stopScanner(){
  scanning = false;
  if (scanToggle) scanToggle.textContent = 'Start Scanner';
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    if (video) video.srcObject = null;
  }
}

function drawViewfinder() {
  if (!overlayCtx || !video || !video.videoWidth) return null;
  const w = overlay.width = video.videoWidth;
  const h = overlay.height = video.videoHeight;
  overlayCtx.clearRect(0,0,w,h);
  const boxW = Math.floor(w * 0.8);
  const boxH = Math.floor(h * 0.35);
  const x = (w - boxW)/2;
  const y = (h - boxH)/2;
  overlayCtx.strokeStyle = 'rgba(255,255,255,0.8)';
  overlayCtx.lineWidth = 3;
  overlayCtx.strokeRect(x,y,boxW,boxH);
  overlayCtx.beginPath();
  overlayCtx.moveTo(x + boxW/2 - 20, y + boxH/2);
  overlayCtx.lineTo(x + boxW/2 + 20, y + boxH/2);
  overlayCtx.moveTo(x + boxW/2, y + boxH/2 - 20);
  overlayCtx.lineTo(x + boxW/2, y + boxH/2 + 20);
  overlayCtx.stroke();
  return {x, y, boxW, boxH, w, h};
}

let lastScanTime = 0;
async function scanFrame(){
  if (!scanning) return;
  if (!video || video.readyState < 2) {
    requestAnimationFrame(scanFrame);
    return;
  }
  const vf = drawViewfinder() || {x:0,y:0,boxW:video.videoWidth||640,boxH:video.videoHeight||480};
  const sampleCanvas = document.createElement('canvas');
  const sctx = sampleCanvas.getContext('2d');
  const scale = 0.6;
  sampleCanvas.width = Math.max(160, Math.floor(vf.boxW * scale));
  sampleCanvas.height = Math.max(120, Math.floor(vf.boxH * scale));
  sctx.drawImage(video, vf.x, vf.y, vf.boxW, vf.boxH, 0,0, sampleCanvas.width, sampleCanvas.height);

  try {
    if (barcodeDetector) {
      const results = await barcodeDetector.detect(sampleCanvas);
      if (results && results.length) {
        handleScanDebounced(results[0].rawValue);
      }
    } else if (ZX) {
      try {
        const luminance = new ZX.HTMLCanvasElementLuminanceSource(sampleCanvas);
        const binary = new ZX.BinaryBitmap(new ZX.HybridBinarizer(luminance));
        const result = ZX.MultiFormatReader.decode(binary);
        if (result) handleScanDebounced(result.getText());
      } catch(e) {
        // ignore
      }
    }
  } catch (err) {
    console.warn('scan error', err);
  }
  requestAnimationFrame(scanFrame);
}

function handleScanDebounced(code) {
  const nowTs = Date.now();
  if (lastScanned === code && (nowTs - lastScanTime) < 1200) return;
  lastScanned = code; lastScanTime = nowTs;
  if (scanResult) scanResult.textContent = `Scanned: ${code}`;
  onScanned(code);
  setTimeout(()=> { if (Date.now() - lastScanTime > 1100) lastScanned = null; }, 1200);
}

// ---------------- product & DB helpers ----------------
async function findProductByBarcode(barcode){
  return db.products.where('barcode').equals(barcode).first();
}

async function saveProduct(p){
  if (!p.created_at) p.created_at = now();
  if (p.is_new === undefined) p.is_new = true;
  const id = await db.products.put(p);
  await renderProducts();
  return id;
}

// ---------------- rendering ----------------
async function renderProducts(){
  if (!productList) return;
  const q = (searchInput && searchInput.value || '').trim().toLowerCase();
  const filter = filterStock ? filterStock.value : 'all';
  const products = await db.products.toArray();
  const filtered = products.filter(p => {
    if (q && !(p.name.toLowerCase().includes(q) || (p.barcode||'').includes(q))) return false;
    if (filter === 'new' && !p.is_new) return false;
    if (filter === 'old' && p.is_new) return false;
    if (filter === 'low' && (Number(p.qty || 0) > 5)) return false;
    return true;
  });
  productList.innerHTML = '';
  for (const p of filtered){
    const el = document.createElement('div');
    el.className = 'product';
    el.innerHTML = `<div>
        <strong>${p.name}</strong><div class="muted">SKU:${p.barcode} · ${p.is_new ? 'New' : 'Old'}</div>
        <div class="muted">Price: KES ${money(p.price)} · Cost: KES ${money(p.cost)}</div>
      </div>
      <div style="text-align:right">
        <div>Qty: ${p.qty}</div>
        <button class="btn" data-id="${p.id}" data-bar="${p.barcode}">+1</button>
      </div>`;
    productList.appendChild(el);
    el.querySelector('button').onclick = () => addToCart(p,1);
  }
}

// ---------------- cart ----------------
function renderCart(){
  if (!cartList) return;
  cartList.innerHTML = '';
  let total = 0;
  for (const line of cart){
    const el = document.createElement('div');
    el.className = 'product';
    const subtotal = line.qty * Number(line.price);
    total += subtotal;
    el.innerHTML = `<div><strong>${line.name}</strong><div class="muted">SKU:${line.barcode}</div></div>
      <div style="text-align:right">
        <div>${line.qty} × ${money(line.price)}</div>
        <div>Subtotal: ${money(subtotal)}</div>
      </div>`;
    cartList.appendChild(el);
  }
  if (cartTotal) cartTotal.textContent = money(total);
}

async function addToCart(product, qty=1){
  const existing = cart.find(c => c.barcode === product.barcode);
  if (existing) existing.qty += qty;
  else cart.push({barcode: product.barcode, name: product.name, price: product.price, cost: product.cost, qty});
  renderCart();
}

// ---------------- checkout & queued sync ----------------
if (checkoutBtn) checkoutBtn.addEventListener('click', async () => {
  if (!cart.length) return alert('Cart is empty');
  const total = cart.reduce((s,l) => s + (l.price*l.qty), 0);
  const lines = cart.map(l => ({barcode:l.barcode,name:l.name,qty:l.qty,price:l.price,cost:l.cost}));
  const local_id = 'local-' + Date.now();
  const tx = {
    createdAt: now(),
    total,
    lines,
    payment_type: 'cash',
    synced: false,
    local_id
  };
  await db.transactions.add(tx);
  for (const l of lines){
    const prod = await db.products.where('barcode').equals(l.barcode).first();
    if (prod){
      prod.qty = Math.max(0, (prod.qty || 0) - l.qty);
      await db.products.put(prod);
    }
  }
  await db.syncQueue.add({payload: tx, attempts: 0});
  cart = [];
  renderCart();
  await renderProducts();
  await updateAnalytics();
  alert('Sale recorded locally. Use "Sync Now" to push to server.');
});

// ---------------- sync implementation (real) ----------------
async function performSync(){
  const items = await db.syncQueue.toArray();
  if (!items.length) return alert('Nothing to sync');
  const txs = items.map(it => it.payload);
  try {
    const res = await fetch(`${API_BASE}/api/sync`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({transactions: txs})
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'sync failed');
    for (const ack of data.ack || []) {
      await db.transactions.where('local_id').equals(ack.local_id).modify({synced: ack.status === 'ok'});
      // remove queue items matching local_id
      const matches = await db.syncQueue.toArray();
      for (const q of matches) {
        if (q.payload && q.payload.local_id === ack.local_id) {
          await db.syncQueue.delete(q.id).catch(()=>{});
        }
      }
    }
    for (const p of (data.updated_products || [])) {
      const local = await db.products.where('barcode').equals(p.barcode).first();
      if (local) {
        local.qty = p.qty; local.price = p.price; local.cost = p.cost; local.name = p.name;
        await db.products.put(local);
      } else {
        await db.products.add(p);
      }
    }
    alert('Sync complete.');
    await renderProducts();
    await updateAnalytics();
  } catch (err) {
    console.error('sync error', err);
    alert('Sync failed: ' + (err.message || err));
    for (const it of items) {
      await db.syncQueue.update(it.id, {attempts: (it.attempts||0) + 1});
    }
  }
}
if (syncBtn) syncBtn.addEventListener('click', performSync);

// ---------------- user management (PINs) ----------------
if (openLogin) openLogin.addEventListener('click', () => loginModal && loginModal.classList.remove('hidden'));
if (cancelLogin) cancelLogin.addEventListener('click', () => loginModal && loginModal.classList.add('hidden'));

if (loginForm) loginForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = $('login_name').value.trim();
  const pin = $('login_pin').value.trim();
  if (!name || !pin) return alert('enter name and pin');
  const pin_h = await hashPin(pin);

  const local = await db.users.where('name').equals(name).first();
  if (local && local.pin_hash === pin_h) {
    activeUser = local;
    loginModal.classList.add('hidden');
    alert(`Welcome (offline): ${local.name}`);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name, pin})
    });
    const data = await res.json();
    if (data.ok) {
      activeUser = data.user;
      const pin_h_local = await hashPin(pin);
      await db.users.put({name: data.user.name, is_admin: data.user.is_admin, pin_hash: pin_h_local});
      loginModal.classList.add('hidden');
      alert(`Welcome: ${data.user.name}`);
    } else {
      alert('Login failed: ' + (data.error || 'invalid'));
    }
  } catch (err) {
    console.error('login error', err);
    alert('Login error: ' + (err.message || err));
  }
});

// Create user via server (requires admin). Prompt for admin credentials to authorize.
if (openCreateUser) openCreateUser.addEventListener('click', async () => {
  const name = prompt('New user name (e.g. cashier1)');
  if (!name) return;
  const pin = prompt('PIN for new user (4+ digits)');
  if (!pin) return;
  const is_admin = confirm('Make this user admin? (choose Cancel for cashier)');
  // ask for admin credentials to authorize
  const admin_name = prompt('Admin name to authorize creation (required)');
  if (!admin_name) return alert('admin name required');
  const admin_pin = prompt('Admin PIN (required)');
  if (!admin_pin) return alert('admin PIN required');

  try {
    const res = await fetch(`${API_BASE}/api/auth/create_user`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name, pin, is_admin, admin_name, admin_pin})
    });
    const data = await res.json();
    if (data.ok) {
      const pin_h = await hashPin(pin);
      await db.users.put({name: data.user.name, is_admin: data.user.is_admin, pin_hash: pin_h});
      alert('Created user on server and saved locally.');
    } else {
      alert('Create user failed: ' + (data.error || 'server error'));
    }
  } catch (err) {
    console.error('create user error', err);
    alert('Create user error: ' + (err.message || err));
  }
});

// ---------------- add product modal (unchanged) ----------------
if (addProductBtn) addProductBtn.onclick = () => openProductModal();
function openProductModal(prefill={}) {
  const title = $('modalTitle');
  if (title) title.textContent = prefill.barcode ? 'Add product (scanned)' : 'Add product';
  productModal && productModal.classList.remove('hidden');
  if (prefill.barcode) $('p_barcode').value = prefill.barcode;
}
const cancelProduct = $('cancelProduct');
if (cancelProduct) cancelProduct.onclick = () => productModal && productModal.classList.add('hidden');

if (productForm) productForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const p = {
    barcode: $('p_barcode').value.trim(),
    name: $('p_name').value.trim(),
    price: Number($('p_price').value),
    cost: Number($('p_cost').value),
    qty: Number($('p_qty').value),
    is_new: $('p_is_new').value === 'true',
    created_at: now()
  };
  const id = await saveProduct(p);
  productModal && productModal.classList.add('hidden');
  productForm.reset();
  await updateAnalytics();

  // optional: push product to server (if online). If server requires admin, this will fail; that's expected.
  try {
    await fetch(`${API_BASE}/api/products`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(p)
    });
  } catch (e){ /* ignore network errors */ }
});

// ---------------- exports & analytics (unchanged logic) ----------------
if (exportCsv) exportCsv.addEventListener('click', async () => {
  const txs = await db.transactions.toArray();
  const rows = [['id','createdAt','total','payment_type']];
  txs.forEach(t => rows.push([t.id,t.createdAt, money(t.total), t.payment_type]));
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'oaks_transactions.csv'; a.click(); URL.revokeObjectURL(url);
});

if (exportPdf) exportPdf.addEventListener('click', async () => {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const txs = await db.transactions.reverse().limit(20).toArray();
  doc.text('Oaks Mart - Recent Transactions', 10, 10);
  let y=20;
  txs.forEach(t => {
    doc.text(`${t.createdAt} — KES ${money(t.total)}`, 10, y);
    y+=8;
  });
  doc.save('oaks_recent_transactions.pdf');
});

async function updateAnalytics(){
  const today = new Date().toISOString().slice(0,10);
  const txs = await db.transactions.toArray();
  const todayTx = txs.filter(t => t.createdAt && t.createdAt.startsWith(today));
  const todaySales = todayTx.reduce((s,t) => s + Number(t.total||0),0);
  const todayProfit = todayTx.reduce((s,t) => {
    const profit = (t.lines || []).reduce((ps,l)=> ps + (Number(l.price)-Number(l.cost))*Number(l.qty),0);
    return s + profit;
  },0);

  const products = await db.products.toArray();
  const top = products.reduce((best,p)=>{
    const sold = txs.reduce((s,t) => s + ((t.lines||[]).filter(l => l.barcode===p.barcode).reduce((x,y)=>x+y.qty,0)), 0);
    if (!best || sold > best.sold) return {name:p.name,sold}; return best;
  }, null);

  const groups = {};
  txs.forEach(t => {
    const day = t.createdAt ? t.createdAt.slice(0,10) : '';
    groups[day] = (groups[day]||0) + Number(t.total||0);
  });
  const last7 = Object.entries(groups).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,7).map(x=>x[1]);
  const expectedTomorrow = last7.length ? (last7.reduce((a,b)=>a+b,0)/last7.length) : 0;

  const elTodaySales = $('todaySales'), elTodayProfit = $('todayProfit'), elTop = $('topSeller'), elExpect = $('expectedTomorrow');
  if (elTodaySales) elTodaySales.textContent = `KES ${money(todaySales)}`;
  if (elTodayProfit) elTodayProfit.textContent = `KES ${money(todayProfit)}`;
  if (elTop) elTop.textContent = top ? `${top.name} (${top.sold})` : '—';
  if (elExpect) elExpect.textContent = `KES ${money(expectedTomorrow)}`;
}

// ---------------- scanning result handling ----------------
async function onScanned(code){
  const product = await findProductByBarcode(code);
  if (product) addToCart(product,1);
  else openProductModal({barcode: code});
}

// ---------------- startup ----------------
if (scanToggle) scanToggle.addEventListener('click', ()=>{ if (scanning) stopScanner(); else startScanner(); });
if (searchInput) searchInput.addEventListener('input', renderProducts);
if (filterStock) filterStock.addEventListener('change', renderProducts);
const clearCartBtn = $('clearCartBtn');
if (clearCartBtn) clearCartBtn.addEventListener('click', ()=>{ cart=[]; renderCart(); });

(async function boot(){
  const count = await db.products.count();
  if (!count) {
    await db.products.bulkAdd([
      {barcode:'1234567890123', name:'Pure Water 500ml', price:30, cost:20, qty:50, is_new:true, created_at:now()},
      {barcode:'9780201379624', name:'Bread (large)', price:80, cost:50, qty:30, is_new:false, created_at:now()},
    ]);
  }
  await renderProducts();
  await updateAnalytics();

  // quick debug: print API base
  console.info('OaksMart frontend API_BASE =', API_BASE);
})();
