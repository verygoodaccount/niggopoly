console.log("WEALTH.IO Script initializing...");

if (typeof Peer === 'undefined') {
    alert("CRITICAL ERROR: PeerJS Library did not load. Check your internet connection or adblocker.");
}

// --- PROGRESS BAR & VIGNETTE ---
function setProgress(percent) {
    const p = document.getElementById('top-progress');
    if(p) {
        p.style.width = percent + '%'; p.style.opacity = '1';
        if(percent >= 100) setTimeout(() => p.style.opacity = '0', 300);
    }
}

function triggerYourTurnAnim() {
    const txt = document.getElementById('your-turn-text');
    if(!txt) return;
    txt.classList.remove('hidden');
    txt.style.animation = 'none'; void txt.offsetWidth; txt.style.animation = 'popFade 2s forwards';
}

let peer = null, isHost = false, myId = null;
let hostConnection = null, clientConnections = [];
let localData = { name: "Player", color: "#6366f1", avatar: null };

const SESSION_KEY = 'wealthio_session';
const HOST_STATE_KEY = 'wealthio_host_state';

// --- GAME STATE ---
let gameState = {
    status: 'lobby', 
    hostId: null, players: [], turnIndex: 0, board: [], logs: [], chat: [], vacationPool: 0,
    currentTurnPhase: 'roll', lastRoll: null,
    auction: { tileIndex: null, highestBid: 0, highestBidderId: null, activeBidders: [], turnIndex: 0 },
    activeTrade: null,
    pausedData: { disconnectedId: null, timeoutLeft: 60 },
    stats: { startTime: null, endTime: null, totalTurns: 0, doublesRolled: 0, totalTrades: 0, totalChats: 0, propertyVisits: {}, prisonVisits: {}, netWorthHistory: {} }
};

let pauseInterval = null;

// --- INITIALIZATION ---
function initApp() {
    console.log("initApp() called. Checking for saved sessions...");
    setProgress(30);
    const saved = localStorage.getItem(SESSION_KEY);
    
    const hb = document.getElementById('hostBtn');
    const jb = document.getElementById('joinBtn');

    if (saved) {
        console.log("Saved session found.");
        const session = JSON.parse(saved);
        document.getElementById('reconnectArea').classList.remove('hidden');
        document.getElementById('mainLobbyCards').classList.add('hidden');
        
        document.getElementById('reconnectBtn').onclick = () => {
            setProgress(60);
            document.getElementById('reconnectBtn').innerText = "Connecting...";
            document.getElementById('reconnectBtn').disabled = true;
            initPeer(session.myId, () => {
                if (session.isHost) resumeHostSession(session); else resumeClientSession(session);
            });
        };
        document.getElementById('clearSessionBtn').onclick = () => {
            localStorage.removeItem(SESSION_KEY); localStorage.removeItem(HOST_STATE_KEY);
            window.location.reload();
        };
    } else { 
        console.log("No saved session. Reaching out to public matchmaking server...");
        
        // Failsafe Timeout
        const timeout = setTimeout(() => {
            if (hb.disabled) {
                console.warn("Server connection timed out after 8 seconds.");
                hb.innerText = "Network Error (Refresh)";
                jb.innerText = "Network Error (Refresh)";
            }
        }, 8000);

        initPeer(null, () => {
            console.log("Peer network connected successfully! Unlocking UI.");
            clearTimeout(timeout);
            setProgress(100);
            hb.innerText = "Create Room"; hb.disabled = false;
            jb.innerText = "Join Room"; jb.disabled = false;
        }); 
    }
}

function initPeer(forceId, callback) {
    console.log("Connecting to PeerJS Network...");
    
    peer = forceId ? new Peer(forceId, { debug: 2 }) : new Peer({ debug: 2 });
    
    peer.on('open', assignedId => { 
        console.log("Assigned ID:", assignedId);
        myId = assignedId; 
        if(callback) callback(); 
    });
    
    peer.on('error', err => {
        console.error("PEERJS ERROR:", err);
        if (err.type === 'unavailable-id') {
            console.log("ID taken, requesting a new random one...");
            peer = new Peer({ debug: 2 });
            peer.on('open', assignedId => { myId = assignedId; if(callback) callback(); });
        } else {
            showToast("Network Error: Check console.");
        }
    });
    
    peer.on('connection', handleHostIncomingConnection);
}

// Add this right above // --- HOST LOGIC ---
function saveSession(hostIdStr, isHosting) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ myId, hostId: hostIdStr, isHost: isHosting }));
}

// --- HOST LOGIC ---
document.getElementById('hostBtn').onclick = () => {
    isHost = true; gameState.hostId = myId; saveSession(myId, true);
    document.getElementById('mainLobbyCards').classList.add('hidden');
    document.getElementById('hostLobbyArea').classList.remove('hidden');
    document.getElementById('hostIdDisplay').innerText = myId;
    addPlayer(myId, getLocalProfile());
};

document.getElementById('hostIdDisplay').onclick = function() {
    navigator.clipboard.writeText(this.innerText);
    showToast("Room Code copied to clipboard!");
};

function resumeHostSession(session) {
    isHost = true;
    const stateStr = localStorage.getItem(HOST_STATE_KEY);
    if(stateStr) gameState = JSON.parse(stateStr);
    setProgress(100); renderGame();
}

function handleHostIncomingConnection(conn) {
    if (!isHost) return;
    conn.on('data', data => {
        if (data.type === 'JOIN') { clientConnections.push(conn); addPlayer(conn.peer, data.profile); }
        if (data.type === 'RECONNECT') {
            clientConnections.push(conn);
            const p = gameState.players.find(pl => pl.id === data.oldId);
            if (p) {
                p.disconnected = false;
                if(gameState.status === 'paused' && gameState.pausedData.disconnectedId === data.oldId) {
                    gameState.status = 'playing'; clearInterval(pauseInterval); addToast(`${p.name} reconnected!`);
                }
                broadcastState();
            }
        }
        if (data.type === 'ACTION') handleAction(data.action, conn.peer);
    });
    conn.on('close', () => {
        const p = gameState.players.find(pl => pl.id === conn.peer);
        if(p && gameState.status === 'playing') triggerDisconnectPause(p.id);
    });
}

function triggerDisconnectPause(playerId) {
    const p = gameState.players.find(pl => pl.id === playerId);
    if(!p || p.bankrupt) return;
    p.disconnected = true; gameState.status = 'paused'; gameState.pausedData = { disconnectedId: playerId, timeoutLeft: 60 };
    broadcastState();
    pauseInterval = setInterval(() => {
        gameState.pausedData.timeoutLeft--;
        if (gameState.pausedData.timeoutLeft <= 0) {
            clearInterval(pauseInterval);
            handleAction({type: 'BANKRUPT'}, p.id);
            gameState.status = 'playing'; addLog(`${p.name} abandoned match.`); addToast(`${p.name} Abandoned.`);
            broadcastState();
        } else { broadcastState(); }
    }, 1000);
}

// --- CLIENT LOGIC ---
document.getElementById('joinBtn').onclick = () => {
    setProgress(50);
    const hostId = document.getElementById('joinIdInput').value;
    hostConnection = peer.connect(hostId);
    setupClientConnection(hostId, false);
};

function resumeClientSession(session) {
    hostConnection = peer.connect(session.hostId);
    setupClientConnection(session.hostId, true);
}

function setupClientConnection(hostId, isReconnect) {
    hostConnection.on('open', () => {
        setProgress(100);
        document.getElementById('mainLobbyCards').classList.add('hidden');
        document.getElementById('hostLobbyArea').classList.remove('hidden');
        document.getElementById('hostIdDisplay').innerText = hostId;
        saveSession(hostId, false);
        if (isReconnect) hostConnection.send({ type: 'RECONNECT', oldId: myId });
        else hostConnection.send({ type: 'JOIN', profile: getLocalProfile() });
    });
    hostConnection.on('data', data => { if (data.type === 'STATE_UPDATE') { gameState = data.state; renderGame(); } });
    hostConnection.on('close', () => alert("Lost connection to Host."));
}

// --- LOBBY PROFILE & SETUP ---
document.getElementById('playerAvatarInput').addEventListener('change', function(e) {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = event => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const MAX = 64; let w = img.width, h = img.height;
            if (w > h) { if (w > MAX) { h *= MAX / w; w = MAX; } } else { if (h > MAX) { w *= MAX / h; h = MAX; } }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            localData.avatar = canvas.toDataURL('image/jpeg', 0.6); 
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
});

function getLocalProfile() {
    localData.name = document.getElementById('playerNameInput').value || "Player";
    localData.color = document.getElementById('playerColorInput').value;
    return localData;
}

function addPlayer(id, profile) {
    gameState.players.push({
        id: id, name: profile.name, color: profile.color, avatar: profile.avatar,
        ready: false, money: 1500, position: 0, inJail: false, bankrupt: false, disconnected: false
    });
    gameState.stats.netWorthHistory[id] = [{turn: 0, netWorth: 1500}];
    broadcastState();
}

document.getElementById('readyBtn').onclick = () => {
    act('READY');
    document.getElementById('readyBtn').disabled = true;
    document.getElementById('readyBtn').innerText = "Waiting...";
};

// --- STAT TRACKING HELPERS ---
function recordNetWorth() {
    gameState.players.forEach(p => {
        if(p.bankrupt) return;
        let nw = p.money;
        gameState.board.forEach(t => {
            if(t.ownerId === p.id) nw += (t.price/2) + (t.houses * ((t.hPrice||0)/2));
        });
        gameState.stats.netWorthHistory[p.id].push({turn: gameState.stats.totalTurns, netWorth: nw});
    });
}

function checkEndGame() {
    const active = gameState.players.filter(p => !p.bankrupt);
    if(active.length <= 1 && gameState.status === 'playing') {
        gameState.status = 'ended';
        gameState.stats.endTime = Date.now();
    }
}

// --- CORE ACTION ENGINE ---
function handleAction(action, playerId) {
    if (!isHost) return;
    const cp = gameState.players[gameState.turnIndex] || {};

    if (action.type === 'CHAT') {
        const p = gameState.players.find(pl=>pl.id===playerId);
        gameState.chat.push({name: p.name, msg: action.msg});
        if(gameState.chat.length > 50) gameState.chat.shift();
        gameState.stats.totalChats++;
        broadcastState(); return;
    }

    if (action.type === 'READY') {
        const p = gameState.players.find(pl=>pl.id===playerId); if(p) p.ready = true;
        if (gameState.players.length >= 2 && gameState.players.every(pl => pl.ready) && gameState.status === 'lobby') {
            gameState.status = 'countdown';
            let count = 3; broadcastState();
            const cd = setInterval(() => {
                count--;
                if(count <= 0) {
                    clearInterval(cd); generateBoard(); gameState.status = 'playing';
                    gameState.stats.startTime = Date.now(); addLog("Game Started!");
                } else { gameState.logs.push(`Starting in ${count}...`); }
                broadcastState();
            }, 1000);
        }
        broadcastState(); return;
    }

    if (gameState.status !== 'playing') return;
    if (cp.id !== playerId && !['BID', 'FOLD', 'ACCEPT_TRADE', 'REJECT_TRADE', 'BANKRUPT', 'SELL_PROP', 'SELL_HOUSE'].includes(action.type)) return;

    if (action.type === 'ROLL' && gameState.currentTurnPhase === 'roll') {
        if (cp.inJail) { gameState.currentTurnPhase = 'jail_decision'; broadcastState(); return; }
        
        const roll = Math.floor(Math.random() * 12) + 1;
        gameState.lastRoll = roll;
        if(Math.random() < 0.16) gameState.stats.doublesRolled++;

        const oldPos = cp.position;
        cp.position = (cp.position + roll) % 40;
        
        if (cp.position < oldPos && cp.position !== 0) { 
            let pVal = 0;
            gameState.board.forEach(t=>{if(t.ownerId===cp.id) pVal+=(t.price+(t.houses*(t.hPrice||0)));});
            const tax = Math.floor(pVal * 0.10);
            cp.money += (200 - tax); addLog(`${cp.name} passed START. Net: $${200-tax}`);
        }

        const tile = gameState.board[cp.position];
        gameState.stats.propertyVisits[cp.position] = (gameState.stats.propertyVisits[cp.position] || 0) + 1;
        addLog(`${cp.name} rolled ${roll}, landed on ${tile.name}.`);

        if (cp.position === 30) { 
            cp.position = 10; cp.inJail = true; 
            gameState.stats.prisonVisits[cp.id] = (gameState.stats.prisonVisits[cp.id] || 0) + 1;
            addLog(`${cp.name} sent to JAIL!`); gameState.currentTurnPhase = 'end'; 
        }
        else if (cp.position === 20) { cp.money += gameState.vacationPool; addLog(`${cp.name} got $${gameState.vacationPool} Vacation!`); gameState.vacationPool = 0; gameState.currentTurnPhase = 'end'; }
        else if (tile.type === 'tax') { cp.money -= tile.amount; gameState.vacationPool += tile.amount; addLog(`Paid $${tile.amount} tax.`); gameState.currentTurnPhase = 'end'; }
        else if (['chance', 'chest'].includes(tile.type)) { drawCard(cp); gameState.currentTurnPhase = 'end'; }
        else if (['property', 'airport', 'company'].includes(tile.type)) {
            if (!tile.ownerId) gameState.currentTurnPhase = 'buy_decision';
            else if (tile.ownerId !== cp.id) {
                const rent = calculateRent(tile, roll);
                cp.money -= rent; gameState.players.find(p=>p.id===tile.ownerId).money += rent;
                addLog(`${cp.name} paid $${rent} rent.`); gameState.currentTurnPhase = 'end';
            } else gameState.currentTurnPhase = 'end';
        } else gameState.currentTurnPhase = 'end';
    }

    if (action.type === 'BUY' && gameState.currentTurnPhase === 'buy_decision') {
        const t = gameState.board[cp.position]; cp.money -= t.price; t.ownerId = cp.id;
        addLog(`${cp.name} bought ${t.name}.`); gameState.currentTurnPhase = 'end';
    }
    
    if (action.type === 'SKIP' && gameState.currentTurnPhase === 'buy_decision') {
        addLog(`Auction started for ${gameState.board[cp.position].name}!`);
        gameState.currentTurnPhase = 'auction';
        gameState.auction = { tileIndex: cp.position, highestBid: 0, highestBidderId: null, activeBidders: gameState.players.filter(p=>!p.bankrupt).map(p=>p.id), turnIndex: 0 };
    }
    
    if (gameState.currentTurnPhase === 'auction') {
        const bidderId = gameState.auction.activeBidders[gameState.auction.turnIndex];
        if (action.type === 'BID' && playerId === bidderId) {
            const amt = action.amount;
            if(amt > gameState.auction.highestBid && gameState.players.find(p=>p.id===playerId).money >= amt) {
                gameState.auction.highestBid = amt; gameState.auction.highestBidderId = playerId;
                nextAuctionTurn(false);
            }
        }
        if (action.type === 'FOLD' && playerId === bidderId) {
            gameState.auction.activeBidders.splice(gameState.auction.turnIndex, 1);
            nextAuctionTurn(true);
        }
    }

    if (gameState.currentTurnPhase === 'jail_decision' && action.type === 'JAIL_ROLL') {
        cp.money -= 10;
        const roll = Math.floor(Math.random() * 12) + 1;
        gameState.lastRoll = roll;
        addLog(`${cp.name} paid $10 & rolled ${roll}.`);
        if (roll >= 10) {
            cp.inJail = false; addLog(`${cp.name} Escaped!`);
            cp.position = (cp.position + roll) % 40; 
            const tile = gameState.board[cp.position];
            if (['property', 'airport', 'company'].includes(tile.type) && !tile.ownerId) {
                gameState.currentTurnPhase = 'buy_decision';
            } else {
                if (tile.type === 'tax') { cp.money-=tile.amount; gameState.vacationPool+=tile.amount; }
                else if (tile.ownerId && tile.ownerId !== cp.id) {
                    const rent = calculateRent(tile, roll);
                    cp.money -= rent; gameState.players.find(p=>p.id===tile.ownerId).money += rent;
                    addLog(`${cp.name} paid $${rent} rent.`);
                }
                gameState.currentTurnPhase = 'end';
            }
        } else {
            addLog(`${cp.name} failed to escape.`);
            gameState.currentTurnPhase = 'end';
        }
    }

    if (action.type === 'SELL_PROP') {
        const t = gameState.board[action.tileIndex];
        if (t.ownerId === playerId && t.houses === 0) {
            t.ownerId = null;
            gameState.players.find(pl=>pl.id===playerId).money += Math.floor(t.price / 2);
            addLog(`Sold ${t.name} for $${Math.floor(t.price/2)}.`);
        }
    }
    if (action.type === 'SELL_HOUSE') {
        const t = gameState.board[action.tileIndex];
        if (t.ownerId === playerId && t.houses > 0) {
            t.houses--;
            gameState.players.find(pl=>pl.id===playerId).money += Math.floor(t.hPrice / 2);
        }
    }
    if (action.type === 'BUILD') {
        const t = gameState.board[action.tileIndex];
        if (t.ownerId === playerId && hasMonopoly(playerId, t.group) && t.houses < 5) {
            const p = gameState.players.find(pl=>pl.id === playerId);
            if(p.money >= t.hPrice) { p.money -= t.hPrice; t.houses++; }
        }
    }

    if (action.type === 'PROPOSE_TRADE') {
        gameState.currentTurnPhase = 'trade_review'; gameState.activeTrade = action.trade; addLog(`${cp.name} sent a trade offer.`);
    }
    if (gameState.currentTurnPhase === 'trade_review') {
        if (action.type === 'ACCEPT_TRADE' && playerId === gameState.activeTrade.to) {
            const p1 = gameState.players.find(p=>p.id===gameState.activeTrade.from);
            const p2 = gameState.players.find(p=>p.id===gameState.activeTrade.to);
            p1.money = p1.money - gameState.activeTrade.offerMoney + gameState.activeTrade.reqMoney;
            p2.money = p2.money + gameState.activeTrade.offerMoney - gameState.activeTrade.reqMoney;
            if(gameState.activeTrade.offerProp >= 0) gameState.board[gameState.activeTrade.offerProp].ownerId = p2.id;
            if(gameState.activeTrade.reqProp >= 0) gameState.board[gameState.activeTrade.reqProp].ownerId = p1.id;
            gameState.stats.totalTrades++; addLog("Trade Accepted!");
            gameState.activeTrade = null; gameState.currentTurnPhase = 'end';
        }
        if (action.type === 'REJECT_TRADE' && playerId === gameState.activeTrade.to) {
            addLog("Trade Rejected."); gameState.activeTrade = null; gameState.currentTurnPhase = 'end';
        }
    }

    if (action.type === 'END_TURN' && gameState.currentTurnPhase === 'end' && cp.money >= 0) {
        gameState.stats.totalTurns++;
        recordNetWorth();
        do { gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length; }
        while (gameState.players[gameState.turnIndex].bankrupt);
        gameState.currentTurnPhase = 'roll'; gameState.lastRoll = null;
    }
    
    if (action.type === 'BANKRUPT') {
        const p = gameState.players.find(pl=>pl.id===playerId); p.bankrupt = true;
        gameState.board.forEach(t=>{if(t.ownerId===p.id){t.ownerId=null; t.houses=0;}});
        addLog(`${p.name} went BANKRUPT!`);
        checkEndGame();
        if(cp.id === playerId && gameState.status === 'playing') handleAction({type: 'END_TURN'}, playerId);
    }

    broadcastState();
}

function nextAuctionTurn(folded = false) {
    if (gameState.auction.activeBidders.length === 0) { addLog(`Property remains unsold.`); gameState.currentTurnPhase = 'end'; return; }
    if (gameState.auction.activeBidders.length === 1) {
        const lastId = gameState.auction.activeBidders[0];
        if (gameState.auction.highestBidderId === lastId) {
            const win = gameState.players.find(p=>p.id===lastId); win.money -= gameState.auction.highestBid;
            gameState.board[gameState.auction.tileIndex].ownerId = win.id;
            addLog(`${win.name} won auction ($${gameState.auction.highestBid})`);
            gameState.currentTurnPhase = 'end'; return;
        }
        gameState.auction.turnIndex = 0; return;
    }
    if(!folded) gameState.auction.turnIndex = (gameState.auction.turnIndex + 1) % gameState.auction.activeBidders.length;
    else if(gameState.auction.turnIndex >= gameState.auction.activeBidders.length) gameState.auction.turnIndex = 0;
}

// --- DATA/HELPER FUNCTIONS ---
function broadcastState() {
    if (!isHost) return;
    localStorage.setItem(HOST_STATE_KEY, JSON.stringify(gameState)); 
    clientConnections.forEach(c => c.send({ type: 'STATE_UPDATE', state: gameState }));
    renderGame();
}

let lastLogCount = 0;
function addLog(msg) { gameState.logs.push(msg); if(gameState.logs.length > 30) gameState.logs.shift(); }

function hasMonopoly(playerId, group) {
    const groupTiles = gameState.board.filter(t => t.group === group);
    return groupTiles.every(t => t.ownerId === playerId);
}

function calculateRent(tile, roll) {
    if (tile.type === 'property') {
        if (tile.houses > 0) return tile.rents[tile.houses];
        if (hasMonopoly(tile.ownerId, tile.group)) return tile.rents[0] * 2;
        return tile.rents[0];
    }
    if (tile.type === 'airport') {
        const count = gameState.board.filter(t => t.type === 'airport' && t.ownerId === tile.ownerId).length;
        if(count===0) return 0;
        return 25 * Math.pow(2, count - 1); // 25, 50, 100, 200
    }
    if (tile.type === 'company') {
        const count = gameState.board.filter(t => t.type === 'company' && t.ownerId === tile.ownerId).length;
        return count === 2 ? 10 : 4;
    }
    return 0;
}

function drawCard(player) {
    const cards = [
        () => { player.money += 200; addLog(`Card: Bank Error! Collect $200.`); },
        () => { player.money -= 100; gameState.vacationPool += 100; addLog(`Card: Doctor Fees. Pay $100.`); },
        () => { player.position = 0; addLog(`Card: Advance to Start.`); },
        () => { 
            let h=0, ht=0;
            gameState.board.forEach(t=>{ if(t.ownerId===player.id){ if(t.houses===5)ht++; else h+=t.houses; }});
            let fee = (h*40) + (ht*115); player.money -= fee; gameState.vacationPool += fee;
            addLog(`Card: Street Repairs! Paid $${fee}.`);
        }
    ];
    cards[Math.floor(Math.random()*cards.length)]();
}

function generateBoard() {
    const b = [
        { name: "START", type: "corner" }, // 0
        { name: "O Block ('The O') ", group: "#8B4513", price: 60, hPrice: 50, rents: [2, 10, 30, 90, 160, 250] }, // 1
        { name: "Treasure", type: "chest" }, // 2
        { name: "Englewood", group: "#8B4513", price: 60, hPrice: 50, rents: [4, 20, 60, 180, 320, 450] }, // 3
        { name: "Income Tax", type: "tax", amount: 200 }, // 4
        { name: "North Airport", type: "airport", price: 200, rents: [25, 50, 100, 200] }, // 5
        { name: "Jackey's Dungeon", group: "#87CEEB", price: 100, hPrice: 50, rents: [6, 30, 90, 270, 400, 550] }, // 6
        { name: "Surprise", type: "chance" }, // 7
        { name: "Coray's Tank", group: "#87CEEB", price: 100, hPrice: 50, rents: [6, 30, 90, 270, 400, 550] }, // 8
        { name: "6650 Fallon Ln", group: "#87CEEB", price: 120, hPrice: 50, rents: [8, 40, 100, 300, 450, 600] }, // 9
        { name: "JAIL", type: "corner" }, // 10
        { name: "Dommy's Prissy Palace", group: "#FF69B4", price: 140, hPrice: 100, rents: [10, 50, 150, 450, 625, 750] }, // 11
        { name: "Trap House Co.", type: "company", price: 150 }, // 12
        { name: "Fag United", group: "#FF69B4", price: 140, hPrice: 100, rents: [10, 50, 150, 450, 625, 750] }, // 13
        { name: "Never Online Kikeland", group: "#FF69B4", price: 160, hPrice: 100, rents: [12, 60, 180, 500, 700, 900] }, // 14
        { name: "East Airport", type: "airport", price: 200, rents: [25, 50, 100, 200] }, // 15
        { name: "Tom Pearl's Bowl", group: "#FFA500", price: 180, hPrice: 100, rents: [14, 70, 200, 550, 750, 950] }, // 16
        { name: "Treasure", type: "chest" }, // 17
        { name: "Stewart Bowman's Shit Cocktail", group: "#FFA500", price: 180, hPrice: 100, rents: [14, 70, 200, 550, 750, 950] }, // 18
        { name: "Pig Norman's Pigslop", group: "#FFA500", price: 200, hPrice: 100, rents: [16, 80, 220, 600, 800, 1000] }, // 19
        { name: "MATERNITY LEAVE", type: "corner" }, // 20
        { name: "Aushwitz", group: "#FF0000", price: 220, hPrice: 150, rents: [18, 90, 250, 700, 875, 1050] }, // 21
        { name: "Surprise", type: "chance" }, // 22
        { name: "Gas Chamber", group: "#FF0000", price: 220, hPrice: 150, rents: [18, 90, 250, 700, 875, 1050] }, // 23
        { name: "Hitler's Bunker", group: "#FF0000", price: 240, hPrice: 150, rents: [20, 100, 300, 750, 925, 1100] }, // 24
        { name: "South Airport", type: "airport", price: 200, rents: [25, 50, 100, 200] }, // 25
        { name: "Tightskin's Kike Concentration Camp", group: "#FFFF00", price: 260, hPrice: 150, rents: [22, 110, 330, 800, 975, 1150] }, // 26
        { name: "Furry Convention", group: "#FFFF00", price: 260, hPrice: 150, rents: [22, 110, 330, 800, 975, 1150] }, // 27
        { name: "Wock n Henny Co.", type: "company", price: 150 }, // 28
        { name: "Cotton Field", group: "#FFFF00", price: 280, hPrice: 150, rents: [24, 120, 360, 850, 1025, 1200] }, // 29
        { name: "GO TO JAIL, NIGGER!", type: "corner" }, // 30
        { name: "Indian Shit Festival", group: "#008000", price: 300, hPrice: 200, rents: [26, 130, 390, 900, 1100, 1275] }, // 31
        { name: "Shit Covered Indian Street Food", group: "#008000", price: 300, hPrice: 200, rents: [26, 130, 390, 900, 1100, 1275] }, // 32
        { name: "Treasure", type: "chest" }, // 33
        { name: "No Shower Land", group: "#008000", price: 320, hPrice: 200, rents: [28, 150, 450, 1000, 1200, 1400] }, // 34
        { name: "West Airport", type: "airport", price: 200, rents: [25, 50, 100, 200] }, // 35
        { name: "Surprise", type: "chance" }, // 36
        { name: "Western Wall (Kike Kiss Wall)", group: "#0000FF", price: 350, hPrice: 200, rents: [35, 175, 500, 1100, 1300, 1500] }, // 37
        { name: "Luxury Tax", type: "tax", amount: 100 }, // 38
        { name: "Twin Towers", group: "#0000FF", price: 400, hPrice: 200, rents: [50, 200, 600, 1400, 1700, 2000] } // 39
    ];
    gameState.board = b.map(t => ({ ...t, ownerId: null, houses: 0, type: t.type || 'property' }));
}

// --- UI INTERACTIONS ---
const act = (type, extra={}) => { if(isHost) handleAction({type, ...extra}, myId); else hostConnection.send({type:'ACTION', action:{type, ...extra}}); }

document.getElementById('rollBtn').onclick = () => act('ROLL');
document.getElementById('buyBtn').onclick = () => act('BUY');
document.getElementById('skipBtn').onclick = () => act('SKIP');
document.getElementById('endTurnBtn').onclick = () => act('END_TURN');
document.getElementById('foldBtn').onclick = () => act('FOLD');
document.getElementById('bankruptBtn').onclick = () => act('BANKRUPT');
document.getElementById('jailRollBtn').onclick = () => act('JAIL_ROLL');

document.getElementById('bidBtn').onclick = () => {
    const val = parseInt(document.getElementById('auctionBidInput').value);
    if(val > gameState.auction.highestBid) act('BID', {amount: val});
};

document.getElementById('chatInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter' && this.value.trim() !== '') {
        act('CHAT', { msg: this.value.trim() }); this.value = '';
    }
});

// Tooltip Management
let selectedTile = null;
document.getElementById('tt-buildBtn').onclick = () => { act('BUILD', {tileIndex: selectedTile}); document.getElementById('tile-tooltip').classList.add('hidden'); };
document.getElementById('tt-sellHouseBtn').onclick = () => { act('SELL_HOUSE', {tileIndex: selectedTile}); document.getElementById('tile-tooltip').classList.add('hidden'); };
document.getElementById('tt-sellPropBtn').onclick = () => { act('SELL_PROP', {tileIndex: selectedTile}); document.getElementById('tile-tooltip').classList.add('hidden'); };

document.addEventListener('click', (e) => {
    if(!e.target.closest('.tile') && !e.target.closest('#tile-tooltip')) {
        document.getElementById('tile-tooltip').classList.add('hidden');
    }
});

document.querySelectorAll('.close-modal').forEach(b => {
    b.onclick = () => { document.getElementById('modal-overlay').classList.add('hidden'); b.closest('.modal').classList.add('hidden'); };
});

document.getElementById('openTradeBtn').onclick = () => {
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.querySelectorAll('.modal').forEach(m=>m.classList.add('hidden'));
    document.getElementById('trade-modal').classList.remove('hidden');
    const targets = gameState.players.filter(p=>!p.bankrupt && p.id !== myId);
    document.getElementById('trade-target').innerHTML = targets.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
    const myProps = gameState.board.map((t,i)=>({t,i})).filter(x=>x.t.ownerId===myId && x.t.houses===0);
    document.getElementById('offer-prop').innerHTML = '<option value="-1">None</option>' + myProps.map(x=>`<option value="${x.i}">${x.t.name}</option>`).join('');
    if(targets.length > 0) {
        const theirProps = gameState.board.map((t,i)=>({t,i})).filter(x=>x.t.ownerId===targets[0].id && x.t.houses===0);
        document.getElementById('request-prop').innerHTML = '<option value="-1">None</option>' + theirProps.map(x=>`<option value="${x.i}">${x.t.name}</option>`).join('');
    }
};
document.getElementById('sendTradeBtn').onclick = () => {
    act('PROPOSE_TRADE', { trade: {
        from: myId, to: document.getElementById('trade-target').value,
        offerProp: parseInt(document.getElementById('offer-prop').value), offerMoney: parseInt(document.getElementById('offer-money').value || 0),
        reqProp: parseInt(document.getElementById('request-prop').value), reqMoney: parseInt(document.getElementById('request-money').value || 0)
    }});
    document.getElementById('trade-modal').classList.add('hidden'); document.getElementById('modal-overlay').classList.add('hidden');
};
document.getElementById('acceptTradeBtn').onclick = () => act('ACCEPT_TRADE');
document.getElementById('rejectTradeBtn').onclick = () => act('REJECT_TRADE');

function showToast(msg) {
    const c = document.getElementById('toast-container'); const t = document.createElement('div'); t.className = 'toast'; t.innerText = msg;
    c.appendChild(t); setTimeout(() => { t.classList.add('toast-fade-out'); setTimeout(() => t.remove(), 500); }, 3000);
}

// --- RENDER ENGINE ---
function getGridPos(index) {
    if (index===0) return {c:1, r:1}; if (index>0 && index<10) return {c:index+1, r:1};
    if (index===10) return {c:11, r:1}; if (index>10 && index<20) return {c:11, r:index-9};
    if (index===20) return {c:11, r:11}; if (index>20 && index<30) return {c:11-(index-20), r:11};
    if (index===30) return {c:1, r:11}; if (index>30 && index<40) return {c:1, r:11-(index-30)};
}

function renderGame() {
    if (gameState.status === 'lobby' || gameState.status === 'countdown') {
        document.getElementById('mainLobbyCards').classList.add('hidden'); document.getElementById('hostLobbyArea').classList.remove('hidden');
        document.getElementById('startWarning').innerText = gameState.players.length < 2 ? "Need at least 2 players to start." : "";
        document.getElementById('lobbyPlayers').innerHTML = gameState.players.map(p => 
            `<div style="display:flex; align-items:center; gap:10px; margin-bottom:5px;">
                <div style="width:20px; height:20px; border-radius:50%; background-color:${p.color}; ${p.avatar ? `background-image:url(${p.avatar}); background-size:cover;` : ''}"></div>
                <span>${p.name} ${p.id===myId?'<strong>(You)</strong>':''} ${p.ready ? '<strong style="color:#10b981">(Ready)</strong>' : ''}</span>
            </div>`
        ).join('');
        return;
    }

    if (gameState.status === 'ended') {
        renderEndScreen();
        return;
    }

    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').classList.remove('hidden');
    document.getElementById('vacationPoolDisplay').innerText = gameState.vacationPool;

    if (gameState.logs.length > lastLogCount) { showToast(gameState.logs[gameState.logs.length - 1]); lastLogCount = gameState.logs.length; }

    if (gameState.status === 'paused') {
        document.getElementById('pause-overlay').classList.remove('hidden');
        const p = gameState.players.find(pl => pl.id === gameState.pausedData.disconnectedId);
        document.getElementById('pause-text').innerText = `Waiting for ${p ? p.name : 'player'} to reconnect...`;
        document.getElementById('pause-timer').innerText = gameState.pausedData.timeoutLeft;
        return;
    } else { document.getElementById('pause-overlay').classList.add('hidden'); }

    document.getElementById('players-list').innerHTML = gameState.players.map((p, i) => `
        <div class="player-stat ${p.bankrupt ? 'bankrupt' : ''}" style="border-color: ${p.color}">
            ${p.avatar ? `<img src="${p.avatar}">` : `<div style="width:30px;height:30px;border-radius:50%;background:${p.color}"></div>`}
            <div><strong>${p.name} ${p.id===myId?'(You)':''}</strong> ${i === gameState.turnIndex && !p.bankrupt ? '★' : ''}<br>
            <span class="${p.money < 0 ? 'negative-money' : ''}" style="color:#10b981">$${p.money}</span></div>
        </div>`).join('');
    
    document.getElementById('log').innerHTML = gameState.logs.map(l => `<div>> ${l}</div>`).join('');
    document.getElementById('log').scrollTop = document.getElementById('log').scrollHeight;

    document.getElementById('chat-messages').innerHTML = gameState.chat.map(c => `<div class="chat-msg"><strong>${c.name}:</strong> ${c.msg}</div>`).join('');
    document.getElementById('chat-messages').scrollTop = document.getElementById('chat-messages').scrollHeight;

    const cp = gameState.players[gameState.turnIndex];
    const isMyTurn = cp && cp.id === myId;
    
    const v = document.getElementById('turn-vignette');
    if (isMyTurn && !cp.bankrupt) {
        if(!v.classList.contains('active-turn-vignette')) { v.classList.add('active-turn-vignette'); triggerYourTurnAnim(); }
    } else { v.classList.remove('active-turn-vignette'); }

    document.getElementById('turn-indicator').innerHTML = `<span style="color:${cp.color}">${cp.name}'s Turn</span>`;
    document.getElementById('dice-display').innerText = gameState.lastRoll || "🎲";
    
    document.getElementById('rollBtn').disabled = !(isMyTurn && gameState.currentTurnPhase === 'roll' && !cp.inJail);
    const tile = gameState.board[cp.position];
    const canBuy = isMyTurn && gameState.currentTurnPhase === 'buy_decision';
    document.getElementById('buyBtn').disabled = !(canBuy && cp.money >= tile.price);
    document.getElementById('skipBtn').disabled = !canBuy;
    document.getElementById('endTurnBtn').disabled = !(isMyTurn && gameState.currentTurnPhase === 'end' && cp.money >= 0);
    
    const me = gameState.players.find(p=>p.id===myId);
    document.getElementById('bankruptBtn').style.display = (me && !me.bankrupt && me.money < 0) ? 'block' : 'none';

    const boardDiv = document.getElementById('board');
    Array.from(boardDiv.children).forEach(c => { if(c.id !== 'center-actions') boardDiv.removeChild(c); });
    
    gameState.board.forEach((t, i) => {
        const div = document.createElement('div');
        div.className = `tile ${t.type==='corner'?'corner':''}`;
        if(i === 10) div.classList.add('jail-tile');
        const pos = getGridPos(i); div.style.gridColumn = pos.c; div.style.gridRow = pos.row || pos.r;
        
        if (i === 10) { 
            div.innerHTML = `
                <div class="jail-cell"><div class="jail-bars"></div><span>IN PRISON</span></div>
                <div class="jail-walkway"><span class="jail-walkway-text">Passing by</span></div>
            `;
        } else {
            if (t.group) div.innerHTML += `<div class="tile-color-bar" style="background-color: ${t.group}"></div>`;
            div.innerHTML += `<div class="tile-name">${t.name}</div>`;
            if (t.price) div.innerHTML += `<div class="tile-price">$${t.price}</div>`;
            if (t.ownerId) {
                const owner = gameState.players.find(p => p.id === t.ownerId);
                if(owner) div.innerHTML += `<div class="tile-owner-indicator" style="background-color: ${owner.color}"></div>`;
            }
            if (t.houses > 0) {
                let bHtml = '<div class="buildings">';
                if(t.houses === 5) bHtml += '<div class="hotel"></div>'; else for(let k=0; k<t.houses; k++) bHtml += '<div class="house"></div>';
                bHtml += '</div>'; div.innerHTML += bHtml;
            }
        }

        const playersOnTile = gameState.players.filter(p => p.position === i && !p.bankrupt);
        if (playersOnTile.length > 0) {
            let tokensHtml = playersOnTile.map(p => `
                <div class="token-container">
                    <div class="token" style="background-color: ${p.color}; ${p.avatar ? `background-image:url(${p.avatar})`:''}"></div>
                    <div class="token-name">${p.name}</div>
                </div>`).join('');
                
            if (i === 10) {
                const inJail = playersOnTile.filter(p=>p.inJail); const outJail = playersOnTile.filter(p=>!p.inJail);
                if(inJail.length) div.querySelector('.jail-cell').innerHTML += `<div class="tokens" style="position:static; transform:none;">${inJail.map(p=>`<div class="token" style="background-color:${p.color}; width:15px; height:15px;"></div>`).join('')}</div>`;
                if(outJail.length) div.querySelector('.jail-walkway').innerHTML += `<div class="tokens" style="position:static; transform:none;">${outJail.map(p=>`<div class="token" style="background-color:${p.color}; width:15px; height:15px;"></div>`).join('')}</div>`;
            } else {
                div.innerHTML += `<div class="tokens">${tokensHtml}</div>`;
            }
        }
        
        div.onclick = (e) => {
            if(['property', 'airport', 'company'].includes(t.type)) {
                selectedTile = i;
                const tt = document.getElementById('tile-tooltip');
                tt.classList.remove('hidden');
                
                const rect = div.getBoundingClientRect();
                tt.style.left = (rect.right + 10) + 'px';
                tt.style.top = rect.top + 'px';
                if(rect.right + 220 > window.innerWidth) tt.style.left = (rect.left - 210) + 'px'; 
                
                document.getElementById('tt-header').innerText = t.name;
                document.getElementById('tt-header').style.backgroundColor = t.group || '#3b3f5c';
                
                let bodyHtml = '';
                if(t.type === 'property') {
                    bodyHtml = `
                        <div class="tt-row highlight"><span>Base Rent</span><span>$${t.rents[0]}</span></div>
                        <div class="tt-row"><span>Full Set</span><span>$${t.rents[0]*2}</span></div>
                        <div class="tt-row"><span>1 House</span><span>$${t.rents[1]}</span></div>
                        <div class="tt-row"><span>2 Houses</span><span>$${t.rents[2]}</span></div>
                        <div class="tt-row"><span>3 Houses</span><span>$${t.rents[3]}</span></div>
                        <div class="tt-row"><span>4 Houses</span><span>$${t.rents[4]}</span></div>
                        <div class="tt-row"><span>Hotel</span><span>$${t.rents[5]}</span></div>
                        <div class="tt-row" style="margin-top:5px; border-top:1px solid #3b3f5c; padding-top:5px;"><span>House Cost</span><span>$${t.hPrice}</span></div>
                    `;
                } else if(t.type === 'airport') {
                    bodyHtml = `
                        <div class="tt-row"><span>1 Airport</span><span>$25</span></div>
                        <div class="tt-row"><span>2 Airports</span><span>$50</span></div>
                        <div class="tt-row"><span>3 Airports</span><span>$100</span></div>
                        <div class="tt-row"><span>4 Airports</span><span>$200</span></div>
                    `;
                } else if(t.type === 'company') {
                    bodyHtml = `
                        <div class="tt-row"><span>1 Company</span><span>$4 flat</span></div>
                        <div class="tt-row"><span>2 Companies</span><span>$10 flat</span></div>
                    `;
                }
                document.getElementById('tt-body').innerHTML = bodyHtml;
                
                const acts = document.getElementById('tt-actions');
                if(t.ownerId === myId) {
                    acts.classList.remove('hidden');
                    document.getElementById('tt-buildBtn').style.display = (t.type==='property' && hasMonopoly(myId, t.group) && t.houses<5) ? 'block' : 'none';
                    document.getElementById('tt-sellHouseBtn').style.display = t.houses > 0 ? 'block' : 'none';
                    document.getElementById('tt-sellPropBtn').style.display = t.houses === 0 ? 'block' : 'none';
                    document.getElementById('tt-sellPropBtn').innerText = `Sell for $${Math.floor(t.price/2)}`;
                } else { acts.classList.add('hidden'); }
            }
        };
        boardDiv.appendChild(div);
    });

    const overlay = document.getElementById('modal-overlay'); let needOverlay = false;
    document.getElementById('auction-modal').classList.add('hidden'); document.getElementById('jail-modal').classList.add('hidden'); document.getElementById('trade-received-modal').classList.add('hidden');

    if (gameState.currentTurnPhase === 'auction') {
        needOverlay = true; document.getElementById('auction-modal').classList.remove('hidden');
        document.getElementById('auction-item').innerText = gameState.board[gameState.auction.tileIndex].name;
        document.getElementById('auction-bid').innerText = "$" + gameState.auction.highestBid;
        const currentBidderId = gameState.auction.activeBidders[gameState.auction.turnIndex];
        const pName = gameState.players.find(p=>p.id===currentBidderId)?.name || '';
        document.getElementById('auction-turn').innerText = pName + "'s turn to bid";
        
        document.getElementById('auctionBidInput').min = gameState.auction.highestBid + 10;
        document.getElementById('auctionBidInput').value = gameState.auction.highestBid + 10;
        
        document.getElementById('bidBtn').disabled = (currentBidderId !== myId) || (me.money < gameState.auction.highestBid + 1);
        document.getElementById('foldBtn').disabled = (currentBidderId !== myId);
    }
    
    if (gameState.currentTurnPhase === 'jail_decision' && isMyTurn) {
        needOverlay = true; document.getElementById('jail-modal').classList.remove('hidden');
    }

    if (gameState.currentTurnPhase === 'trade_review' && gameState.activeTrade && gameState.activeTrade.to === myId) {
        needOverlay = true; document.getElementById('trade-received-modal').classList.remove('hidden');
        const t = gameState.activeTrade;
        document.getElementById('trade-details').innerHTML = `They offer: <strong>${t.offerProp>=0?gameState.board[t.offerProp].name:'None'}</strong> + $${t.offerMoney}<br>They want: <strong>${t.reqProp>=0?gameState.board[t.reqProp].name:'None'}</strong> + $${t.reqMoney}`;
    }

    if (needOverlay) overlay.classList.remove('hidden'); else overlay.classList.add('hidden');
}

// --- END SCREEN GRAPHICS ---
function renderEndScreen() {
    document.getElementById('game').classList.add('hidden');
    document.getElementById('end-screen').classList.remove('hidden');
    
    const s = gameState.stats;
    const winner = gameState.players.find(p => !p.bankrupt) || gameState.players[0];
    
    document.getElementById('end-winner').innerHTML = `${winner.avatar ? `<img src="${winner.avatar}" style="width:40px;height:40px;border-radius:50%;">` : `<div style="width:40px;height:40px;border-radius:50%;background:${winner.color};"></div>`} ${winner.name}`;
    
    const durMins = Math.floor((s.endTime - s.startTime) / 60000);
    const durSecs = Math.floor(((s.endTime - s.startTime) % 60000) / 1000);
    document.getElementById('stat-duration').innerText = `${durMins}m ${durSecs}s`;
    
    document.getElementById('stat-turns').innerText = s.totalTurns;
    document.getElementById('stat-doubles').innerText = s.doublesRolled;
    document.getElementById('stat-trades').innerText = s.totalTrades;
    document.getElementById('stat-chats').innerText = s.totalChats;
    
    let maxV = 0, maxTile = -1;
    for(let t in s.propertyVisits) { if(s.propertyVisits[t] > maxV) { maxV = s.propertyVisits[t]; maxTile = t; } }
    document.getElementById('stat-visited').innerText = maxTile >= 0 ? `${gameState.board[maxTile].name} (${maxV})` : "None";
    
    let maxP = 0, pName = "None";
    for(let id in s.prisonVisits) { if(s.prisonVisits[id] > maxP) { maxP = s.prisonVisits[id]; pName = gameState.players.find(pl=>pl.id===id).name; } }
    document.getElementById('stat-prison').innerHTML = maxP > 0 ? `<span style="color:#f43f5e;">${pName} (${maxP})</span>` : "None (0)";

    const canvas = document.getElementById('netWorthChart');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    let maxNW = 1500;
    for(let id in s.netWorthHistory) { s.netWorthHistory[id].forEach(pt => { if(pt.netWorth > maxNW) maxNW = pt.netWorth; }); }
    
    ctx.strokeStyle = "#2a2d3e"; ctx.lineWidth = 1;
    for(let i=0; i<=5; i++) {
        let y = canvas.height - (i/5)*canvas.height;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
        ctx.fillStyle = "#a9b1d6"; ctx.font = "10px sans-serif"; ctx.fillText("$"+Math.floor(maxNW*(i/5)), 5, y-5);
    }
    
    gameState.players.forEach(p => {
        const hist = s.netWorthHistory[p.id];
        if(!hist || hist.length === 0) return;
        
        ctx.strokeStyle = p.color; ctx.lineWidth = 3;
        ctx.beginPath();
        hist.forEach((pt, i) => {
            const x = (pt.turn / Math.max(1, s.totalTurns)) * canvas.width;
            const y = canvas.height - (pt.netWorth / maxNW) * canvas.height;
            if(i===0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
    });
}

document.getElementById('returnHomeBtn').onclick = () => { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(HOST_STATE_KEY); window.location.reload(); };

// --- BOOT PROCESS ---
console.log("Script mapped! Executing initApp()...");
initApp();