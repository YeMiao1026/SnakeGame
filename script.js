/* script.js
   Front-end game logic:
   - Single Player
   - Single Player vs AI (Easy/Normal/Hard)
   - Multiplayer client (WebSocket)
   - Special foods and power-ups
*/

// ========= Config =========
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const GRID = 30; // cells per side
const CELL = canvas.width / GRID; // pixel size of each cell
const BASE_TICK = 150; // base ms per step
const MIN_TICK = 60; // fastest after speedups
const SCORE_PER_FOOD = 1;

// Colors
const COLORS = {
  bg: '#07121a',
  snake: '#33cc33',
  playerSnake: '#00e0ff',
  aiSnake: '#ff8b4b',
  food: '#e6d562',
  special: {
    bonus: '#ffd700', // gold
    slow: '#4da6ff',  // blue
    poison: '#a24bff',// purple
    invisible: '#ffffff' // transparent-looking white
  },
  grid: 'rgba(255,255,255,0.03)'
};

// Game state (supports single and multiplayer rendering)
let mode = null; // "single", "ai", "mp"
let running = false;
let tickInterval = BASE_TICK;
let tickTimer = null;
let score = 0;
let playerDir = 'right';
let requestRestart = false;
let invisibleTailTicks = 0;
let speedBoost = 0;

// Entities for single/AI modes
let playerSnake = null;
let aiSnake = null;
let foods = []; // [{x,y,type,expires}]
let specialFood = null;
let gameTime = 0; // seconds
let gameDuration = 120; // used for AI timed matches
let aiDifficulty = 'normal';

// Multiplayer
let ws = null;
let mpRoom = null;
let mpName = '';
let roomState = null; // server authoritative snapshot

// DOM
const menu = document.getElementById('menu');
const gameScreen = document.getElementById('game-screen');
const scoreEl = document.getElementById('score');
const modeIndicator = document.getElementById('mode-indicator');
const timerEl = document.getElementById('timer');
const mpPanel = document.getElementById('mp-panel');
const aiOptions = document.getElementById('ai-options');
const playerListEl = document.getElementById('player-list');
const gameOverPanel = document.getElementById('game-over');
const gameOverText = document.getElementById('game-over-text');

// Buttons
document.getElementById('btn-single').onclick = () => startMenuMode('single');
document.getElementById('btn-ai').onclick = () => openAIMenu();
document.getElementById('btn-mp').onclick = () => openMPMenu();
document.getElementById('btn-pause').onclick = () => togglePause();
document.getElementById('btn-back').onclick = () => backToMenu();
document.getElementById('btn-restart').onclick = () => restartGame();
document.getElementById('go-restart').onclick = () => restartGame();
document.getElementById('go-menu').onclick = () => backToMenu();
document.querySelectorAll('.ai-diff').forEach(btn => btn.onclick = (e)=> startAIMode(e.target.dataset.diff));
document.getElementById('mp-create').onclick = createRoom;
document.getElementById('mp-join').onclick = joinRoom;

// keyboard input (WASD)
window.addEventListener('keydown', (e)=>{
  if(!running && e.key.toLowerCase()==='p') return togglePause();
  const k = e.key.toLowerCase();
  if(k==='w' && playerDir!=='down') playerDir='up';
  if(k==='s' && playerDir!=='up') playerDir='down';
  if(k==='a' && playerDir!=='right') playerDir='left';
  if(k==='d' && playerDir!=='left') playerDir='right';

  // In multiplayer, send desired direction to server
  if(mode === 'mp' && ws && ws.readyState === WebSocket.OPEN){
    ws.send(JSON.stringify({type:'input', dir:playerDir}));
  }
});

// Utility helpers
function randCell(){ return {x: Math.floor(Math.random()*GRID), y: Math.floor(Math.random()*GRID)}; }
function eq(a,b){ return a.x===b.x && a.y===b.y; }
function insideGrid(p){ return p.x>=0 && p.x<GRID && p.y>=0 && p.y<GRID; }
function drawRect(cell, color, offset=0){
  ctx.fillStyle = color;
  ctx.fillRect(cell.x*CELL + offset, cell.y*CELL + offset, CELL - offset*2, CELL - offset*2);
}

// ====== Game Entities ======
function makeSnake(initialCells, color){
  return {
    body: initialCells.slice(),
    dir: 'right',
    color,
    alive: true,
    pendingGrow: 0,
    speedMultiplier: 1
  };
}

function placeFood(type='normal'){
  // ensure not colliding with snakes
  for(let attempt=0; attempt<200; attempt++){
    const pos = randCell();
    if(collisionAt(pos)) continue;
    const f = {x:pos.x, y:pos.y, type, spawnedAt: Date.now()};
    if(type==='special') f.subtype = randomSpecialSubtype();
    foods.push(f);
    return f;
  }
  return null;
}

function randomSpecialSubtype(){
  const list = ['bonus','slow','poison','invisible'];
  return list[Math.floor(Math.random()*list.length)];
}

function collisionAt(pos){ // check against player and ai snakes in single mode
  if(playerSnake){
    if(playerSnake.body.some(s=>eq(s,pos))) return true;
  }
  if(aiSnake){
    if(aiSnake.body.some(s=>eq(s,pos))) return true;
  }
  return false;
}

// ====== Main render ======
function renderGrid(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // subtle grid
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 0.6;
  for(let i=0;i<=GRID;i++){
    ctx.beginPath();
    ctx.moveTo(i*CELL,0);
    ctx.lineTo(i*CELL,canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0,i*CELL);
    ctx.lineTo(canvas.width,i*CELL);
    ctx.stroke();
  }
}

function renderSnake(snake, hideTail=false){
  if(!snake) return;
  for(let i=0;i<snake.body.length;i++){
    const seg = snake.body[i];
    // if invisible effect active and it's the tail region, skip rendering
    if(hideTail && i > snake.body.length - 4) continue; // small invisibility
    drawRect(seg, snake.color);
  }
}

function renderFoods(){
  for(const f of foods){
    const c = f.type === 'normal' ? COLORS.food : COLORS.special[f.subtype];
    // translucent for invisible food
    if(f.type!=='normal' && f.subtype === 'invisible'){
      ctx.globalAlpha = 0.6;
      drawRect(f, c);
      ctx.globalAlpha = 1;
    } else {
      drawRect(f, c);
    }
  }
}

// ====== Game loop / tick ======
function startTick(){
  if(tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(gameTick, tickInterval);
  running = true;
}

function stopTick(){
  if(tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  running = false;
}

function setSpeedFromScore(){
  // increase speed slightly with score, cap at MIN_TICK
  const newTick = Math.max(MIN_TICK, BASE_TICK - Math.floor(score/5)*10 - speedBoost);
  if(newTick !== tickInterval){
    tickInterval = newTick;
    if(running) startTick();
  }
}

function gameTick(){
  gameTime += tickInterval/1000;
  timerEl.textContent = `Time: ${Math.floor(gameTime)}s`;
  // move snakes
  if(mode === 'single' || mode === 'ai'){
    stepSnake(playerSnake, playerDir);
    if(mode === 'ai' && aiSnake && aiSnake.alive) aiStep();
    // collisions and food handling
    handleFoodCollisions();
    handleCollisionsSingleMode();
    // render
    renderGrid();
    renderFoods();
    renderSnake(playerSnake, invisibleTailTicks>0);
    if(mode==='ai') renderSnake(aiSnake);
    scoreEl.textContent = `Score: ${score}`;
    setSpeedFromScore();

    // manage power-up timers
    if(invisibleTailTicks>0) invisibleTailTicks -= 1;
  } else if(mode === 'mp'){
    // render server snapshot
    if(roomState){
      renderGrid();
      foods = roomState.foods || [];
      renderFoods();
      // players
      playerListEl.innerHTML = '';
      for(const p of roomState.players){
        const color = p.color || COLORS.playerSnake;
        // render snake
        const snakeObj = {body: p.body, color};
        renderSnake(snakeObj, p.invisible);
        // player list
        const div = document.createElement('div');
        div.className = 'player';
        div.textContent = `${p.name}: ${p.score}${p.alive ? '' : ' (dead)'}`;
        div.style.background = 'rgba(255,255,255,0.04)';
        playerListEl.appendChild(div);
      }
      // update scoreboard
      scoreEl.textContent = `Score: ${roomState.scores ? JSON.stringify(roomState.scores) : ''}`;
    }
  }
}

// ====== Single-player step & collision ======
function stepSnake(snake, dir){
  if(!snake || !snake.alive) return;
  const head = {...snake.body[0]};
  switch(dir){
    case 'up': head.y -= 1; break;
    case 'down': head.y += 1; break;
    case 'left': head.x -= 1; break;
    case 'right': head.x += 1; break;
  }
  // wrap-around allowed? We will treat walls as lethal for single player.
  if(!insideGrid(head)){
    snake.alive = false;
    onPlayerDie(snake === playerSnake ? 'player' : 'ai');
    return;
  }
  // insert new head
  snake.body.unshift(head);
  if(snake.pendingGrow>0){
    snake.pendingGrow--;
  } else {
    snake.body.pop();
  }
}

function handleFoodCollisions(){
  // check if player ate food
  for(let i=foods.length-1;i>=0;i--){
    const f = foods[i];
    if(eq(f, playerSnake.body[0])){
      consumeFood(playerSnake, f, 'player');
      foods.splice(i,1);
      continue;
    }
    if(aiSnake && aiSnake.alive && eq(f, aiSnake.body[0])){
      consumeFood(aiSnake, f, 'ai');
      foods.splice(i,1);
      continue;
    }
  }
}

function consumeFood(snake, food, eater){
  if(food.type === 'normal'){
    snake.pendingGrow += 1;
    if(eater==='player') score += SCORE_PER_FOOD;
    snake.speedMultiplier *= 1.03; // slight speed change
    // increase speed globally for single player
    speedBoost = Math.max(0, speedBoost - 2); // reduce delay a bit
    // spawn another normal food
    placeFood('normal');
  } else if(food.type==='special'){
    switch(food.subtype){
      case 'bonus':
        if(eater==='player') score += 5;
        snake.pendingGrow += 2;
        break;
      case 'slow':
        // decrease snake speed for 3 seconds (increase tick interval temporarily)
        tickInterval = Math.min(400, tickInterval + 120);
        setTimeout(()=>{ tickInterval = Math.max(MIN_TICK, BASE_TICK - Math.floor(score/5)*10 - speedBoost); if(running) startTick(); }, 3000);
        break;
      case 'poison':
        if(eater==='player') score = Math.max(0, score - 2);
        // shorten by 2 segments
        for(let k=0;k<2;k++) snake.body.pop();
        break;
      case 'invisible':
        if(eater==='player') invisibleTailTicks = Math.floor(5000 / tickInterval); // seconds -> ticks approximate
        break;
    }
    // remove special; no immediate speed changes except above
  }
}

// collision checks (single/ai)
function handleCollisionsSingleMode(){
  // self-collision for player
  if(playerSnake.alive){
    const head = playerSnake.body[0];
    for(let i=1;i<playerSnake.body.length;i++){
      if(eq(head, playerSnake.body[i])){
        playerSnake.alive = false;
        onPlayerDie('player');
      }
    }
  }

  // player vs ai collisions
  if(aiSnake && aiSnake.alive){
    const headA = aiSnake.body[0];
    // ai collision with self
    for(let i=1;i<aiSnake.body.length;i++) if(eq(headA, aiSnake.body[i])){
      aiSnake.alive = false;
      onPlayerDie('ai');
    }
    // head-to-head
    if(playerSnake.alive && eq(playerSnake.body[0], aiSnake.body[0])){
      playerSnake.alive = false;
      aiSnake.alive = false;
      onPlayerDie('both');
    }
    // head into other body
    if(playerSnake.alive){
      for(let seg of aiSnake.body){
        if(eq(playerSnake.body[0], seg)){
          playerSnake.alive = false;
          onPlayerDie('player');
        }
      }
    }
    if(aiSnake.alive){
      for(let seg of playerSnake.body){
        if(eq(aiSnake.body[0], seg)){
          aiSnake.alive = false;
          onPlayerDie('ai');
        }
      }
    }
  }
}

function onPlayerDie(which){
  if(mode==='single'){
    showGameOver(`Game Over — Score ${score}`);
  } else if(mode==='ai'){
    if(which==='player') showGameOver(`You Died — Score ${score}`);
    else if(which==='ai') showGameOver(`AI Died — You Win! Score ${score}`);
    else showGameOver(`Both Died — Score ${score}`);
  }
  stopTick();
}

// ====== AI logic ======
function startAIMode(diff){
  aiDifficulty = diff;
  startMenuMode('ai');
}

function openAIMenu(){
  menu.classList.add('hidden');
  aiOptions.classList.remove('hidden');
  gameScreen.classList.remove('hidden');
  // position aiOptions
  aiOptions.style.top = '140px';
  aiOptions.style.left = 'calc(50% - 160px)';
}

function openMPMenu(){
  menu.classList.add('hidden');
  mpPanel.classList.remove('hidden');
  gameScreen.classList.remove('hidden');
  mpPanel.style.top = '120px';
  mpPanel.style.left = 'calc(50% - 160px)';
}

function startMenuMode(m){
  mode = m;
  menu.classList.add('hidden');
  aiOptions.classList.add('hidden');
  mpPanel.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  initGame();
  if(mode==='single' || mode==='ai') {
    startTick();
  }
  modeIndicator.textContent = `Mode: ${mode}`;
}

function initGame(){
  // reset
  stopTick();
  foods = [];
  specialFood = null;
  score = 0;
  tickInterval = BASE_TICK;
  speedBoost = 0;
  gameTime = 0;
  invisibleTailTicks = 0;
  requestRestart = false;

  // create player snake in middle
  playerDir = 'right';
  const mid = Math.floor(GRID/2);
  playerSnake = makeSnake([{x:mid-2,y:mid},{x:mid-3,y:mid},{x:mid-4,y:mid}], COLORS.playerSnake);
  // place one normal food
  placeFood('normal');

  // special food spawn schedule
  if(window.specialTimer) clearInterval(window.specialTimer);
  window.specialTimer = setInterval(()=>{
    // only one special allowed
    if(foods.find(f=>f.type==='special')) return;
    if(Math.random() < 0.6) placeFood('special'); // 60% chance every 10s
  }, 10000);

  // AI
  if(mode==='ai'){
    const pos = {x: Math.floor(GRID*0.2), y: Math.floor(GRID*0.2)};
    aiSnake = makeSnake([pos, {x:pos.x-1,y:pos.y}, {x:pos.x-2,y:pos.y}], COLORS.aiSnake);
    aiSnake.dir = 'right';
    aiSnake.difficulty = aiDifficulty || 'normal';
  } else {
    aiSnake = null;
  }

  // multiplayer setup is separate
  if(mode==='mp'){
    // prepare ws connection (if not connected)
    initWebSocket();
  }

  // UI
  scoreEl.textContent = `Score: ${score}`;
  playerListEl.innerHTML = '';
  gameOverPanel.classList.add('hidden');
  document.getElementById('btn-restart').classList.add('hidden');
}

// AI step
function aiStep(){
  if(!aiSnake.alive) return;
  // choose target: nearest normal or special food
  const head = aiSnake.body[0];
  if(aiSnake.difficulty === 'easy'){
    // random-ish movement, avoid direct wall collisions
    if(Math.random() < 0.2) {
      const choices = ['up','down','left','right'];
      aiSnake.dir = choices[Math.floor(Math.random()*4)];
    }
    // keep it inside grid: if near wall, choose inward direction
    if(head.x<2) aiSnake.dir = 'right';
    if(head.x>GRID-3) aiSnake.dir = 'left';
    if(head.y<2) aiSnake.dir = 'down';
    if(head.y>GRID-3) aiSnake.dir = 'up';
    stepSnake(aiSnake, aiSnake.dir);
    return;
  }

  // For normal/hard: attempt pathfinding to nearest food
  const target = findNearestFood(head);
  if(!target){
    // fallback move forward
    stepSnake(aiSnake, aiSnake.dir);
    return;
  }

  // BFS pathfinding (grid-based avoiding walls and snake bodies)
  const path = bfsPath(head, target, aiSnake);
  if(path && path.length>1){
    const next = path[1]; // path[0] is current head
    if(next.x > head.x) aiSnake.dir='right';
    if(next.x < head.x) aiSnake.dir='left';
    if(next.y > head.y) aiSnake.dir='down';
    if(next.y < head.y) aiSnake.dir='up';
  } else {
    // no path found; try small random move to escape
    const choices = ['up','down','left','right'];
    aiSnake.dir = choices[Math.floor(Math.random()*4)];
  }
  // Normal difficulty randomly ignores collisions sometimes
  if(aiSnake.difficulty === 'normal' && Math.random()<0.12){
    const choices = ['up','down','left','right'];
    aiSnake.dir = choices[Math.floor(Math.random()*4)];
  }
  stepSnake(aiSnake, aiSnake.dir);
}

// find nearest food by Manhattan distance
function findNearestFood(pos){
  if(foods.length===0) return null;
  let best = null, bestDist = Infinity;
  for(const f of foods){
    const d = Math.abs(f.x - pos.x) + Math.abs(f.y - pos.y);
    if(d < bestDist){ bestDist = d; best = f; }
  }
  return best;
}

// BFS path avoiding walls and snake bodies
function bfsPath(start, goal, selfSnake){
  const q = [];
  const visited = new Set();
  const key = p=>`${p.x},${p.y}`;
  q.push({p:start, path:[start]});
  visited.add(key(start));

  // obstacles: player snake body and ai snake bodies (except tail maybe)
  const obstacles = new Set();
  if(playerSnake) playerSnake.body.forEach(s => obstacles.add(key(s)));
  if(aiSnake) aiSnake.body.forEach(s => obstacles.add(key(s)));

  while(q.length){
    const cur = q.shift();
    const p = cur.p;
    if(eq(p, goal)) return cur.path;
    const neighbors = [
      {x:p.x+1,y:p.y},{x:p.x-1,y:p.y},{x:p.x,y:p.y+1},{x:p.x,y:p.y-1}
    ];
    for(const n of neighbors){
      const kn = key(n);
      if(!insideGrid(n)) continue;
      if(visited.has(kn)) continue;
      // allow stepping on goal even if obstacle, to let AI eat food near bodies
      if(obstacles.has(kn) && !eq(n, goal)) continue;
      visited.add(kn);
      q.push({p:n, path: cur.path.concat([n])});
    }
  }
  return null;
}

// ====== UI helpers ======
function showGameOver(msg){
  gameOverText.textContent = msg;
  gameOverPanel.classList.remove('hidden');
  document.getElementById('btn-restart').classList.remove('hidden');
}

function restartGame(){
  initGame();
  if(mode==='single' || mode==='ai') startTick();
  else if(mode==='mp' && ws && ws.readyState===WebSocket.OPEN){
    ws.send(JSON.stringify({type:'restart'}));
  }
}

function backToMenu(){
  stopTick();
  menu.classList.remove('hidden');
  gameScreen.classList.add('hidden');
  aiOptions.classList.add('hidden');
  mpPanel.classList.add('hidden');
  if(ws){ ws.close(); ws = null;}
}

// pause
function togglePause(){
  if(running){ stopTick(); document.getElementById('btn-pause').textContent = 'Resume';}
  else { startTick(); document.getElementById('btn-pause').textContent = 'Pause';}
}

// ====== Multiplayer client logic (WebSocket) ======
function initWebSocket(){
  if(ws && ws.readyState !== WebSocket.CLOSED) return;
  // change URL if different server
  const URL = (location.hostname || 'localhost');
  const port = 8080;
  ws = new WebSocket(`ws://${URL}:${port}`);
  const status = document.getElementById('mp-status');
  status.textContent = 'Connecting to server...';
  ws.onopen = ()=>{
    status.textContent = 'Connected. Enter name and create or join room.';
    // send handshake if name exists
    if(mpName) ws.send(JSON.stringify({type:'hello', name: mpName}));
  };
  ws.onmessage = (ev)=>{
    const data = JSON.parse(ev.data);
    handleServerMessage(data);
  };
  ws.onclose = ()=>{
    status.textContent = 'Disconnected.';
  };
  ws.onerror = (err)=>{ status.textContent = 'Connection error'; console.error(err); };
}

function createRoom(){
  mpName = document.getElementById('mp-name').value || ('P'+Math.floor(Math.random()*9000));
  mpRoom = null;
  if(!ws || ws.readyState !== WebSocket.OPEN) initWebSocket();
  ws.onopen = ()=> {
    ws.send(JSON.stringify({type:'create', name: mpName}));
    document.getElementById('mp-status').textContent = 'Creating...';
  };
}

function joinRoom(){
  mpName = document.getElementById('mp-name').value || ('P'+Math.floor(Math.random()*9000));
  const roomId = document.getElementById('mp-room-input').value.trim();
  if(!roomId){ document.getElementById('mp-status').textContent = 'Enter room id'; return; }
  if(!ws || ws.readyState !== WebSocket.OPEN) initWebSocket();
  ws.onopen = ()=> {
    ws.send(JSON.stringify({type:'join', name: mpName, room: roomId}));
    document.getElementById('mp-status').textContent = 'Joining...';
  };
}

function handleServerMessage(msg){
  const status = document.getElementById('mp-status');
  switch(msg.type){
    case 'created':
      mpRoom = msg.room;
      status.textContent = `Room created: ${mpRoom}. Waiting for players...`;
      break;
    case 'joined':
      mpRoom = msg.room;
      status.textContent = `Joined room ${mpRoom}. Waiting or game starting...`;
      break;
    case 'error':
      status.textContent = `Error: ${msg.message}`;
      break;
    case 'state':
      // full room state for rendering
      roomState = msg.state;
      break;
    case 'start':
      mode = 'mp';
      initGame(); // not to wipe ws
      startTick(); // use render tick for client updates (server authoritative)
      status.textContent = `Game started in room ${mpRoom}`;
      break;
    case 'result':
      showGameOver(msg.message);
      break;
  }
}

// ====== start in menu ======
(function boot(){
  // draw blank grid
  renderGrid();
})();
