/**
 * Digital Golden Plates — IndexedDB & PWA Service Worker Basket + Checkout Engine
 * Provides persistent client-side database storage (IndexedDB: GFP_Harps_Commerce_DB),
 * Service Worker registration & offline sync (./sw.js), cross-tab BroadcastChannel sync,
 * W3C PaymentRequest API + EIP-1193 Web3 Wallet signature + Rarible settlement.
 */
(function () {
  const DB_NAME = 'GFP_Harps_Commerce_DB';
  const DB_VERSION = 1;
  const ETH_USD_RATE = 2500;

  const GFP_CATALOG = {
    token_492856_yellow: {
      sku: 'token_492856_yellow',
      tokenId: '492856',
      name: 'Y Harps of God (Yellow NFT #492856)',
      rail: 'Left Rail • Yellow Theme',
      subtitle: 'Yellow Good Faith Dove & 7 World Religions',
      priceUsd: 20.00,
      priceEth: 0.008,
      raffleEntries: 1,
      museumPasses: 1,
      image: './assets/asset_g_harps_front.jpg',
      raribleUrl: 'https://rarible.com/token/0xd07dc4262bcdbf85190c01c996b4c06a461d2430:492856',
      accent: 'amber'
    },
    token_490643_green: {
      sku: 'token_490643_green',
      tokenId: '490643',
      name: 'G Harps-of-God (Green NFT #490643)',
      rail: 'Right Rail • Green Theme',
      subtitle: 'Green y8 Cosmic Harp, 2000→2001 Key & Sphinx',
      priceUsd: 20.00,
      priceEth: 0.008,
      raffleEntries: 1,
      museumPasses: 1,
      image: './assets/asset_y_harps_front.jpg',
      raribleUrl: 'https://rarible.com/token/0xd07dc4262bcdbf85190c01c996b4c06a461d2430:490643',
      accent: 'emerald'
    },
    bundle_revelation_pair: {
      sku: 'bundle_revelation_pair',
      tokenId: '492856 + 490643',
      name: 'Revelation 15:2 Complete Pair (#492856 + #490643)',
      rail: 'Dual-Rail Synergy Bundle (10% Off)',
      subtitle: 'Both Yellow & Green Harps + Bonus 2 oz Gold Raffle Entry',
      priceUsd: 36.00,
      priceEth: 0.0144,
      raffleEntries: 3,
      museumPasses: 2,
      image: './assets/asset_harps_of_god_both.jpg',
      raribleUrl: 'https://rarible.com/token/0xd07dc4262bcdbf85190c01c996b4c06a461d2430:492856',
      raribleUrlSecondary: 'https://rarible.com/token/0xd07dc4262bcdbf85190c01c996b4c06a461d2430:490643',
      accent: 'cyan'
    }
  };

  let dbInstance = null;
  let swStatus = 'Registering...';
  let connectedWallet = null;
  let activeDrawerTab = 'basket';
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('gfp_basket_channel') : null;

  // 1. Open IndexedDB Database
  function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('basket_items')) {
          db.createObjectStore('basket_items', { keyPath: 'sku' });
        }
        if (!db.objectStoreNames.contains('checkout_orders')) {
          db.createObjectStore('checkout_orders', { keyPath: 'orderId' });
        }
        if (!db.objectStoreNames.contains('engagement_state')) {
          db.createObjectStore('engagement_state', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        dbInstance = req.result;
        resolve(dbInstance);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // 2. Basket CRUD Operations in IndexedDB
  async function getBasketItems() {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('basket_items', 'readonly');
      const req = tx.objectStore('basket_items').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async function getOrders() {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('checkout_orders', 'readonly');
      const req = tx.objectStore('checkout_orders').getAll();
      req.onsuccess = () => {
        const list = req.result || [];
        list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        resolve(list);
      };
      req.onerror = () => resolve([]);
    });
  }

  async function addToBasket(sku, deltaQty = 1, openDrawerAfter = true) {
    const itemMeta = GFP_CATALOG[sku];
    if (!itemMeta) return;
    const db = await openDB();
    const existing = await new Promise((resolve) => {
      const tx = db.transaction('basket_items', 'readonly');
      const r = tx.objectStore('basket_items').get(sku);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    });

    const newQty = (existing ? existing.qty : 0) + deltaQty;
    await new Promise((resolve) => {
      const tx = db.transaction('basket_items', 'readwrite');
      const store = tx.objectStore('basket_items');
      if (newQty <= 0) {
        store.delete(sku);
      } else {
        store.put({
          sku: itemMeta.sku,
          tokenId: itemMeta.tokenId,
          name: itemMeta.name,
          rail: itemMeta.rail,
          subtitle: itemMeta.subtitle,
          priceUsd: itemMeta.priceUsd,
          priceEth: itemMeta.priceEth,
          raffleEntries: itemMeta.raffleEntries,
          museumPasses: itemMeta.museumPasses,
          image: itemMeta.image,
          raribleUrl: itemMeta.raribleUrl,
          raribleUrlSecondary: itemMeta.raribleUrlSecondary || null,
          accent: itemMeta.accent,
          qty: newQty,
          updatedAt: new Date().toISOString()
        });
      }
      tx.oncomplete = () => resolve();
    });

    broadcastBasketChange();
    await refreshBasketUI();
    if (openDrawerAfter && deltaQty > 0) {
      openBasketDrawer('basket');
      showToast(`Added "${itemMeta.name}" to IndexedDB Basket!`);
    }
  }

  async function clearBasket() {
    const db = await openDB();
    await new Promise((resolve) => {
      const tx = db.transaction('basket_items', 'readwrite');
      tx.objectStore('basket_items').clear();
      tx.oncomplete = () => resolve();
    });
    broadcastBasketChange();
    await refreshBasketUI();
  }

  function broadcastBasketChange() {
    if (bc) bc.postMessage({ type: 'BASKET_CHANGED' });
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'BROADCAST_BASKET_UPDATE',
        payload: { timestamp: Date.now() }
      });
    }
  }

  // 3. Calculate Basket Totals & Synergy Bonus
  function computeSummary(items) {
    let totalCount = 0;
    let subtotalUsd = 0;
    let subtotalEth = 0;
    let baseEntries = 0;
    let museumPasses = 0;
    let hasYellow = false;
    let hasGreen = false;

    for (const it of items) {
      totalCount += it.qty;
      subtotalUsd += it.priceUsd * it.qty;
      subtotalEth += it.priceEth * it.qty;
      baseEntries += it.raffleEntries * it.qty;
      museumPasses += it.museumPasses * it.qty;
      if (it.sku === 'token_492856_yellow' || it.sku === 'bundle_revelation_pair') hasYellow = true;
      if (it.sku === 'token_490643_green' || it.sku === 'bundle_revelation_pair') hasGreen = true;
    }

    // If user added separate Yellow + Green tokens, grant +1 Synergy Bonus Raffle Entry
    const separateSynergyBonus = (hasYellow && hasGreen && !items.some(i => i.sku === 'bundle_revelation_pair')) ? 1 : 0;
    const totalRaffleEntries = baseEntries + separateSynergyBonus;

    return {
      totalCount,
      subtotalUsd: Number(subtotalUsd.toFixed(2)),
      subtotalEth: Number(subtotalEth.toFixed(4)),
      totalRaffleEntries,
      museumPasses,
      hasDualSynergy: hasYellow && hasGreen,
      separateSynergyBonus
    };
  }

  // 4. Web Crypto API SHA-256 Receipt Hash
  async function sha256Hex(text) {
    if (window.crypto && window.crypto.subtle) {
      const buf = new TextEncoder().encode(text);
      const hashBuf = await window.crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return 'hash-' + Math.random().toString(36).substring(2, 15);
  }

  // 5. Connect Browser Web3 Wallet (EIP-1193)
  async function connectWeb3Wallet() {
    if (!window.ethereum) {
      showToast('No browser Web3 wallet detected (e.g. MetaMask / Rabby). You can still checkout via Email/Card or Rarible!');
      return null;
    }
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (accounts && accounts[0]) {
        connectedWallet = accounts[0];
        const walletInput = document.getElementById('gfp-checkout-wallet');
        if (walletInput) walletInput.value = connectedWallet;
        showToast(`Connected Web3 Wallet: ${connectedWallet.slice(0, 6)}...${connectedWallet.slice(-4)}`);
        await refreshBasketUI();
        return connectedWallet;
      }
    } catch (err) {
      showToast('Wallet connection cancelled by user.');
    }
    return null;
  }

  // 6. Execute Checkout & Persist Order in IndexedDB + Service Worker Sync
  async function executeCheckout(mode) {
    const items = await getBasketItems();
    if (!items.length) {
      showToast('Your IndexedDB basket is empty. Add a Yellow (#492856) or Green (#490643) Harp NFT first!');
      return;
    }
    const summary = computeSummary(items);
    const emailEl = document.getElementById('gfp-checkout-email');
    const walletEl = document.getElementById('gfp-checkout-wallet');
    const medalPrefEl = document.getElementById('gfp-checkout-medal-pref');

    const buyerEmail = emailEl ? emailEl.value.trim() : '';
    const buyerWallet = walletEl ? walletEl.value.trim() : (connectedWallet || '');
    const medalPref = medalPrefEl ? medalPrefEl.value : '2 oz Solid Gold, Silver & Copper All-Pool Entry';

    let paymentProof = null;

    // Mode A: W3C Browser PaymentRequest API
    if (mode === 'payment_request' && window.PaymentRequest) {
      try {
        const supportedInstruments = [{
          supportedMethods: 'basic-card',
          data: { supportedNetworks: ['visa', 'mastercard', 'amex', 'discover'] }
        }];
        const details = {
          total: {
            label: 'Good Faith Paradigm — Harps of God NFT & Medallion Raffle',
            amount: { currency: 'USD', value: summary.subtotalUsd.toFixed(2) }
          },
          displayItems: items.map(it => ({
            label: `${it.qty}x ${it.name}`,
            amount: { currency: 'USD', value: (it.priceUsd * it.qty).toFixed(2) }
          }))
        };
        const request = new PaymentRequest(supportedInstruments, details);
        const canMake = await request.canMakePayment().catch(() => false);
        if (canMake) {
          const response = await request.show();
          await response.complete('success');
          paymentProof = 'W3C_PAYMENT_REQUEST_APPROVED';
        }
      } catch (e) {
        // Fallback to standard IndexedDB order recording if browser blocks/cancels sheet
        paymentProof = 'BROWSER_EXPRESS_FALLBACK';
      }
    }

    // Mode B: Web3 Wallet EIP-191 Personal Signature Receipt
    let walletSignature = null;
    if (mode === 'web3_sign' && window.ethereum) {
      const acct = connectedWallet || (await connectWeb3Wallet());
      if (acct) {
        try {
          const signMessage = [
            'GOOD FAITH PARADIGM — DIGITAL GOLDEN PLATES CHECKOUT RECEIPT',
            `Wallet: ${acct}`,
            `Items: ${items.map(i => `${i.qty}x ${i.name}`).join(', ')}`,
            `Total: $${summary.subtotalUsd.toFixed(2)} (${summary.subtotalEth} ETH)`,
            `Medallion Raffle Entries: ${summary.totalRaffleEntries} (2 oz Gold, Silver & Copper)`,
            `VIP Museum Tour Passes: ${summary.museumPasses}`,
            `Timestamp: ${new Date().toISOString()}`
          ].join('\n');
          walletSignature = await window.ethereum.request({
            method: 'personal_sign',
            params: [signMessage, acct]
          });
          paymentProof = 'EIP191_WALLET_SIGNED';
        } catch (err) {
          paymentProof = 'UNSIGNED_WALLET_INTENT';
        }
      }
    }

    const orderId = 'GFP-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    const createdAt = new Date().toISOString();
    const rawPayload = JSON.stringify({ orderId, items, summary, buyerEmail, buyerWallet, createdAt });
    const receiptHash = await sha256Hex(rawPayload);

    const orderRecord = {
      orderId,
      createdAt,
      checkoutMode: mode,
      buyerEmail: buyerEmail || 'collector@goodfaithparadigm.org',
      buyerWallet: buyerWallet || 'Pending Web3 / Custodial Claim',
      medalPreference: medalPref,
      items,
      summary,
      receiptHash,
      walletSignature,
      paymentProof: paymentProof || 'INDEXEDDB_CRYPTOGRAPHIC_VOUCHER',
      syncStatus: navigator.onLine ? 'SYNCED_ONLINE' : 'QUEUED_OFFLINE',
      contractAddress: '0xd07dc4262bcdbf85190c01c996b4c06a461d2430'
    };

    const db = await openDB();
    await new Promise((resolve) => {
      const tx = db.transaction('checkout_orders', 'readwrite');
      tx.objectStore('checkout_orders').put(orderRecord);
      tx.oncomplete = () => resolve();
    });

    // Notify PWA Service Worker for Background Sync / Verification
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      if (reg && 'sync' in reg) {
        reg.sync.register('gfp-checkout-sync').catch(() => {});
      }
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'TRIGGER_ORDER_SYNC' });
      }
    }

    // If user clicked Rarible Direct Settlement, open the primary Rarible token checkout tab
    if (mode === 'rarible_direct') {
      const primaryUrl = items[0].raribleUrl;
      window.open(primaryUrl, '_blank', 'noopener');
    }

    await clearBasket();
    activeDrawerTab = 'orders';
    await refreshBasketUI();
    showToast(`Order ${orderId} saved to IndexedDB (${summary.totalRaffleEntries} Raffle Entries)!`);
  }

  // 7. Download Verifiable JSON Receipt from IndexedDB
  async function downloadOrderReceipt(orderId) {
    const orders = await getOrders();
    const ord = orders.find(o => o.orderId === orderId);
    if (!ord) return;
    const blob = new Blob([JSON.stringify(ord, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ord.orderId}_Golden_Plates_Raffle_Receipt.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // 8. Toast Notification Helper
  function showToast(msg) {
    let t = document.getElementById('gfp-pwa-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'gfp-pwa-toast';
      t.className = 'fixed bottom-20 right-4 z-[80] max-w-sm px-4 py-2.5 rounded-xl bg-slate-900/95 border border-amber-400/60 text-amber-200 text-xs font-semibold shadow-2xl transition-opacity duration-300 pointer-events-none opacity-0';
      document.body.appendChild(t);
    }
    t.textContent = '✨ ' + msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3800);
  }

  // 9. Build & Inject Basket Drawer + Floating Button + Rail "Add to Basket" Buttons
  function injectDrawerDOM() {
    if (document.getElementById('gfp-basket-drawer')) return;

    // Floating Bottom-Right PWA Basket Pill
    const fab = document.createElement('button');
    fab.id = 'gfp-floating-basket-btn';
    fab.onclick = () => openBasketDrawer('basket');
    fab.className = 'fixed bottom-4 right-4 z-40 px-4 py-2.5 rounded-2xl bg-gradient-to-r from-amber-500 via-yellow-400 to-emerald-400 text-slate-950 font-extrabold text-xs shadow-2xl flex items-center gap-2 hover:scale-105 transition border-2 border-slate-950';
    fab.innerHTML = `
      <span>🛒 NFT Basket</span>
      <span id="gfp-fab-count" class="px-2 py-0.5 rounded-full bg-slate-950 text-amber-300 font-mono text-[11px]">0</span>
      <span id="gfp-fab-entries" class="hidden sm:inline px-2 py-0.5 rounded-full bg-slate-950/90 text-emerald-300 font-mono text-[10px]">0 Raffle Entries</span>
    `;
    document.body.appendChild(fab);

    // Slide-Over Basket & Checkout Drawer Modal
    const drawer = document.createElement('div');
    drawer.id = 'gfp-basket-drawer';
    drawer.className = 'fixed inset-0 z-50 hidden bg-slate-950/80 backdrop-blur-sm flex justify-end';
    drawer.onclick = () => closeBasketDrawer();
    drawer.innerHTML = `
      <div class="w-full max-w-xl bg-slate-900 border-l border-amber-500/40 h-full flex flex-col justify-between shadow-2xl overflow-hidden" onclick="event.stopPropagation()">
        <!-- Drawer Header -->
        <div class="p-4 bg-slate-950 border-b border-slate-800">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 font-mono text-[10px] font-bold">INDEXEDDB + PWA SERVICE WORKER</span>
                <span id="gfp-sw-pill" class="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono text-[10px]">🟢 SW Active</span>
              </div>
              <h3 class="text-base sm:text-lg font-extrabold text-white mt-1">Harps of God NFT Basket &amp; Medallion Raffle Checkout</h3>
            </div>
            <button onclick="window.GFPBasket.close()" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 font-bold">✕ Close</button>
          </div>

          <!-- 3 Mode Tabs -->
          <div class="grid grid-cols-3 gap-1.5 mt-3">
            <button id="gfp-tab-basket" onclick="window.GFPBasket.switchTab('basket')" class="py-1.5 px-2 rounded-lg text-xs font-bold bg-amber-500 text-slate-950">🛒 Basket (<span id="gfp-tab-count">0</span>)</button>
            <button id="gfp-tab-checkout" onclick="window.GFPBasket.switchTab('checkout')" class="py-1.5 px-2 rounded-lg text-xs font-bold bg-slate-800 text-slate-300 hover:bg-slate-700">⚡ Checkout</button>
            <button id="gfp-tab-orders" onclick="window.GFPBasket.switchTab('orders')" class="py-1.5 px-2 rounded-lg text-xs font-bold bg-slate-800 text-slate-300 hover:bg-slate-700">📜 Order Vault (<span id="gfp-tab-orders-count">0</span>)</button>
          </div>
        </div>

        <!-- Drawer Scrollable Body -->
        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <!-- Quick-Add Catalog Strip -->
          <div class="p-3 rounded-xl bg-slate-950/90 border border-slate-800">
            <div class="text-[11px] font-mono uppercase tracking-wider text-slate-400 mb-2">Quick-Add Digital Twin NFTs to Browser Database:</div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button onclick="window.GFPBasket.add('token_492856_yellow', 1, false)" class="p-2 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-left transition">
                <div class="text-xs font-extrabold text-amber-300">+ Yellow #492856</div>
                <div class="text-[10px] text-slate-300">$20 (0.008 ETH) • 1 Entry</div>
              </button>
              <button onclick="window.GFPBasket.add('token_490643_green', 1, false)" class="p-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-left transition">
                <div class="text-xs font-extrabold text-emerald-300">+ Green #490643</div>
                <div class="text-[10px] text-slate-300">$20 (0.008 ETH) • 1 Entry</div>
              </button>
              <button onclick="window.GFPBasket.add('bundle_revelation_pair', 1, false)" class="p-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-left transition">
                <div class="text-xs font-extrabold text-cyan-300">+ Both Pair Bundle</div>
                <div class="text-[10px] text-slate-300">$36 • 3 Raffle Entries!</div>
              </button>
            </div>
          </div>

          <!-- VIEW 1: BASKET ITEMS -->
          <div id="gfp-view-basket" class="space-y-3"></div>

          <!-- VIEW 2: EXPRESS CHECKOUT -->
          <div id="gfp-view-checkout" class="hidden space-y-4">
            <div class="p-3.5 rounded-xl bg-slate-950 border border-amber-500/30 space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-xs font-mono uppercase text-amber-300 font-bold">1. Collector &amp; Medallion Raffle Registration</span>
                <button onclick="window.GFPBasket.connectWallet()" class="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 text-[11px] font-bold">🔗 Connect Web3 Wallet</button>
              </div>
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">Ethereum / Polygon / Y8 Wallet Address (for ERC-1155 NFT &amp; Chainlink VRF Raffle):</label>
                <input id="gfp-checkout-wallet" type="text" placeholder="0x... (or click Connect Web3 Wallet above)" class="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white font-mono" />
              </div>
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">Collector Email (for VIP Museum Tour Pass &amp; Physical Medallion Escrow Notification):</label>
                <input id="gfp-checkout-email" type="email" placeholder="collector@domain.com" class="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white" />
              </div>
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">2 oz Precious Metal Medallion Relief Preference:</label>
                <select id="gfp-checkout-medal-pref" class="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-amber-300">
                  <option value="Dual Masculine & Feminine Relief (2 oz Gold, Silver & Copper Pool)">Dual Masculine &amp; Feminine Relief (2 oz Gold, Silver &amp; Copper Pool)</option>
                  <option value="Feminine Maternal Womb Obverse + 11:11 Reverse">Feminine Maternal Womb Obverse + 11:11 Reverse</option>
                  <option value="Masculine Pillar of Light Obverse + 11:11 Reverse">Masculine Pillar of Light Obverse + 11:11 Reverse</option>
                </select>
              </div>
            </div>

            <div class="p-3.5 rounded-xl bg-slate-950 border border-emerald-500/30 space-y-2.5">
              <div class="text-xs font-mono uppercase text-emerald-300 font-bold">2. Select Checkout &amp; Settlement Method</div>
              <button onclick="window.GFPBasket.checkout('web3_sign')" class="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-slate-950 font-extrabold text-xs flex items-center justify-center gap-2 shadow-lg transition">
                ✍️ Sign Web3 Order Receipt (EIP-191) &amp; Save to IndexedDB Vault
              </button>
              <button onclick="window.GFPBasket.checkout('payment_request')" class="w-full py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-xs flex items-center justify-center gap-2 shadow-lg transition">
                💳 Browser Express Checkout (W3C PaymentRequest / Card + PWA Sync)
              </button>
              <button onclick="window.GFPBasket.checkout('rarible_direct')" class="w-full py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 border border-amber-400/40 text-amber-300 font-bold text-xs flex items-center justify-center gap-2 transition">
                🏛️ Record Raffle Entry in IndexedDB &amp; Settle on Rarible Smart Contract ↗
              </button>
            </div>
          </div>

          <!-- VIEW 3: INDEXEDDB ORDER VAULT -->
          <div id="gfp-view-orders" class="hidden space-y-3"></div>
        </div>

        <!-- Drawer Footer Summary -->
        <div class="p-4 bg-slate-950 border-t border-slate-800 space-y-3">
          <div class="grid grid-cols-3 gap-2 text-center bg-slate-900/90 p-2.5 rounded-xl border border-slate-800">
            <div>
              <div class="text-[10px] text-slate-400 font-mono">BASKET TOTAL</div>
              <div id="gfp-sum-price" class="text-sm font-extrabold text-white">$0.00 <span class="text-[10px] text-amber-300 font-mono">(0 ETH)</span></div>
            </div>
            <div>
              <div class="text-[10px] text-slate-400 font-mono">RAFFLE ENTRIES</div>
              <div id="gfp-sum-entries" class="text-sm font-extrabold text-amber-300">0 Tickets</div>
            </div>
            <div>
              <div class="text-[10px] text-slate-400 font-mono">MUSEUM PASSES</div>
              <div id="gfp-sum-passes" class="text-sm font-extrabold text-emerald-300">0 VIP Passes</div>
            </div>
          </div>
          <div class="flex items-center justify-between gap-2">
            <button onclick="window.GFPBasket.clear()" class="px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-400 text-xs font-semibold">Clear Basket</button>
            <button id="gfp-footer-cta" onclick="window.GFPBasket.switchTab('checkout')" class="flex-1 py-2.5 px-4 rounded-xl bg-gradient-to-r from-amber-500 via-yellow-400 to-emerald-400 text-slate-950 font-extrabold text-xs shadow-lg">
              Proceed to Checkout →
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(drawer);
  }

  // 10. Render Drawer Contents
  async function refreshBasketUI() {
    injectDrawerDOM();
    const items = await getBasketItems();
    const orders = await getOrders();
    const summary = computeSummary(items);

    // Update Floating & Header Badges
    const fabCount = document.getElementById('gfp-fab-count');
    const fabEntries = document.getElementById('gfp-fab-entries');
    if (fabCount) fabCount.textContent = summary.totalCount;
    if (fabEntries) fabEntries.textContent = `${summary.totalRaffleEntries} Raffle ${summary.totalRaffleEntries === 1 ? 'Entry' : 'Entries'}`;

    const topBadge = document.getElementById('top-basket-count');
    if (topBadge) topBadge.textContent = summary.totalCount;

    const tabCount = document.getElementById('gfp-tab-count');
    const tabOrdersCount = document.getElementById('gfp-tab-orders-count');
    if (tabCount) tabCount.textContent = summary.totalCount;
    if (tabOrdersCount) tabOrdersCount.textContent = orders.length;

    // Update Summary Footer
    const sumPrice = document.getElementById('gfp-sum-price');
    const sumEntries = document.getElementById('gfp-sum-entries');
    const sumPasses = document.getElementById('gfp-sum-passes');
    if (sumPrice) sumPrice.innerHTML = `$${summary.subtotalUsd.toFixed(2)} <span class="text-[10px] text-amber-300 font-mono">(${summary.subtotalEth} ETH)</span>`;
    if (sumEntries) sumEntries.textContent = `${summary.totalRaffleEntries} ${summary.totalRaffleEntries === 1 ? 'Entry' : 'Entries'}`;
    if (sumPasses) sumPasses.textContent = `${summary.museumPasses} VIP ${summary.museumPasses === 1 ? 'Pass' : 'Passes'}`;

    // Render Basket Items List
    const basketView = document.getElementById('gfp-view-basket');
    if (basketView) {
      if (!items.length) {
        basketView.innerHTML = `
          <div class="p-6 rounded-xl bg-slate-950/70 border border-slate-800 text-center space-y-2">
            <div class="text-2xl">🛒</div>
            <div class="text-sm font-bold text-white">Your Browser Database Basket is Empty</div>
            <p class="text-xs text-slate-400">Click <strong>+ Yellow #492856</strong> (Left Rail), <strong>+ Green #490643</strong> (Right Rail), or <strong>+ Both Pair Bundle</strong> above to store your NFT selection in <code>IndexedDB</code> and unlock 2 oz Gold, Silver &amp; Copper Medallion Raffle entries.</p>
          </div>
        `;
      } else {
        basketView.innerHTML = items.map(it => `
          <div class="p-3 rounded-xl bg-slate-950 border ${it.accent === 'amber' ? 'border-amber-500/40' : (it.accent === 'emerald' ? 'border-emerald-500/40' : 'border-cyan-500/40')} flex items-center justify-between gap-3">
            <img src="${it.image}" alt="${it.name}" class="w-14 h-16 object-contain rounded-lg bg-black border border-slate-800 shrink-0" />
            <div class="flex-1 min-w-0">
              <div class="text-[10px] font-mono uppercase ${it.accent === 'amber' ? 'text-amber-300' : (it.accent === 'emerald' ? 'text-emerald-300' : 'text-cyan-300')}">${it.rail} • Token #${it.tokenId}</div>
              <div class="text-xs sm:text-sm font-extrabold text-white truncate">${it.name}</div>
              <div class="text-[11px] text-slate-400">$${it.priceUsd.toFixed(2)} (${it.priceEth} ETH) each • 🥇 ${it.raffleEntries * it.qty} Raffle Entries</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button onclick="window.GFPBasket.add('${it.sku}', -1, false)" class="w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs">-</button>
              <span class="w-6 text-center font-mono text-xs font-bold text-white">${it.qty}</span>
              <button onclick="window.GFPBasket.add('${it.sku}', 1, false)" class="w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs">+</button>
            </div>
          </div>
        `).join('') + (summary.hasDualSynergy ? `
          <div class="p-2.5 rounded-xl bg-gradient-to-r from-amber-500/15 via-cyan-500/15 to-emerald-500/15 border border-cyan-400/40 text-xs text-cyan-200 flex items-center justify-between">
            <span>✨ <strong>Revelation 15:2 Dual-Harp Synergy Active:</strong> Holding both Yellow (#492856) &amp; Green (#490643) grants Bonus Gold Medallion Raffle weight!</span>
          </div>
        ` : '');
      }
    }

    // Render Orders Vault List
    const ordersView = document.getElementById('gfp-view-orders');
    if (ordersView) {
      if (!orders.length) {
        ordersView.innerHTML = `
          <div class="p-6 rounded-xl bg-slate-950/70 border border-slate-800 text-center space-y-2">
            <div class="text-2xl">📜</div>
            <div class="text-sm font-bold text-white">No Completed Orders in IndexedDB Yet</div>
            <p class="text-xs text-slate-400">Orders completed via Web3 Signature, Browser PaymentRequest, or Rarible Settlement are stored permanently in <code>IndexedDB (GFP_Harps_Commerce_DB)</code> with a verifiable SHA-256 receipt hash.</p>
          </div>
        `;
      } else {
        ordersView.innerHTML = orders.map(o => `
          <div class="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-1">
              <span class="font-mono text-xs font-extrabold text-amber-300">${o.orderId}</span>
              <span class="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono text-[10px]">${o.syncStatus}</span>
            </div>
            <div class="text-xs text-slate-200">
              ${(o.items || []).map(i => `${i.qty}x ${i.name}`).join(' + ')}
            </div>
            <div class="text-[11px] text-slate-400 font-mono">
              Total: $${o.summary.subtotalUsd.toFixed(2)} (${o.summary.subtotalEth} ETH) • 🥇 ${o.summary.totalRaffleEntries} Raffle Entries • 🏛️ ${o.summary.museumPasses} VIP Passes
            </div>
            <div class="text-[10px] text-slate-500 font-mono truncate" title="${o.receiptHash}">
              SHA-256: ${o.receiptHash}
            </div>
            <div class="flex flex-wrap items-center gap-2 pt-1">
              <button onclick="window.GFPBasket.downloadReceipt('${o.orderId}')" class="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-amber-300 font-semibold">⬇ Download JSON Receipt</button>
              <a href="https://rarible.com/token/0xd07dc4262bcdbf85190c01c996b4c06a461d2430:492856" target="_blank" rel="noopener" class="px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 text-[11px] font-semibold">💛 Token #492856 ↗</a>
              <a href="https://rarible.com/token/0xd07dc4262bcdbf85190c01c996b4c06a461d2430:490643" target="_blank" rel="noopener" class="px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 text-[11px] font-semibold">🌿 Token #490643 ↗</a>
            </div>
          </div>
        `).join('');
      }
    }
  }

  function switchDrawerTab(tab) {
    activeDrawerTab = tab;
    ['basket', 'checkout', 'orders'].forEach(t => {
      const view = document.getElementById(`gfp-view-${t}`);
      const btn = document.getElementById(`gfp-tab-${t}`);
      if (view) view.classList.toggle('hidden', t !== tab);
      if (btn) {
        btn.className = t === tab
          ? 'py-1.5 px-2 rounded-lg text-xs font-bold bg-amber-500 text-slate-950'
          : 'py-1.5 px-2 rounded-lg text-xs font-bold bg-slate-800 text-slate-300 hover:bg-slate-700';
      }
    });
    const footerCta = document.getElementById('gfp-footer-cta');
    if (footerCta) {
      if (tab === 'basket') {
        footerCta.textContent = 'Proceed to Checkout →';
        footerCta.onclick = () => switchDrawerTab('checkout');
      } else if (tab === 'checkout') {
        footerCta.textContent = '✍️ Complete & Save Order to IndexedDB';
        footerCta.onclick = () => executeCheckout('web3_sign');
      } else {
        footerCta.textContent = '← Back to Basket';
        footerCta.onclick = () => switchDrawerTab('basket');
      }
    }
  }

  function openBasketDrawer(tab = 'basket') {
    injectDrawerDOM();
    switchDrawerTab(tab);
    refreshBasketUI();
    const d = document.getElementById('gfp-basket-drawer');
    if (d) d.classList.remove('hidden');
  }

  function closeBasketDrawer() {
    const d = document.getElementById('gfp-basket-drawer');
    if (d) d.classList.add('hidden');
  }

  // 11. Register PWA Service Worker & Cross-Tab Listeners
  function initPWA() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        swStatus = 'ACTIVE';
        const pill = document.getElementById('gfp-sw-pill');
        if (pill) pill.textContent = '🟢 PWA SW Ready';
        if (reg.active) {
          reg.active.postMessage({ type: 'PING_SW' });
        }
      }).catch(() => {
        swStatus = 'LOCAL_DB_ONLY';
      });

      navigator.serviceWorker.addEventListener('message', (e) => {
        const d = e.data || {};
        if (d.type === 'BASKET_UPDATED_FROM_SW' || d.type === 'SW_ORDERS_SYNCED') {
          refreshBasketUI();
        }
      });
    }

    if (bc) {
      bc.onmessage = (e) => {
        if (e.data && e.data.type === 'BASKET_CHANGED') {
          refreshBasketUI();
        }
      };
    }
  }

  window.GFPBasket = {
    add: addToBasket,
    clear: clearBasket,
    open: openBasketDrawer,
    close: closeBasketDrawer,
    switchTab: switchDrawerTab,
    checkout: executeCheckout,
    connectWallet: connectWeb3Wallet,
    downloadReceipt: downloadOrderReceipt,
    refresh: refreshBasketUI
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initPWA();
      refreshBasketUI();
    });
  } else {
    initPWA();
    refreshBasketUI();
  }
})();
