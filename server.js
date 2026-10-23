// Rocket Rivals — standalone server + WebGL client + 60Hz game physics.
// Everything is bundled in this file to make iPad/GitHub uploads simpler.
'use strict';
const http=require('http');
const crypto=require('crypto');
const {Match}=(()=>{
const module={exports:{}};
'use strict';

const WIDTH = 34;
const LENGTH = 50;
const SIDE = WIDTH / 2;
const END = LENGTH / 2;
const GOAL_W = 10.8;
const GOAL_H = 4.5;
const BALL_R = 1.02;
const CAR_R = 1.7;
const MAX_BALL_SPEED = 43;
const MATCH_LENGTH = 180;
const BOOSTS = [
  [-12, -17, 100], [12, 17, 100], [-12, 17, 100], [12, -17, 100],
  [-8, 0, 28], [8, 0, 28], [0, -12, 28], [0, 12, 28],
  [-12, -6, 28], [12, 6, 28], [-12, 6, 28], [12, -6, 28]
];
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const norm2 = (x,z) => Math.hypot(x,z) || 1;
const smooth = (current,target,factor) => current+(target-current)*factor;

function makeCar(index) {
  return {
    id: index, x: index === 0 ? -4 : 4, y: .67, z: index === 0 ? 13 : -13,
    yaw: index === 0 ? 0 : Math.PI, pitch:0, roll:0,
    vx:0, vy:0, vz:0, boost:100, grounded:true, jumps:0, jumpLock:false,
    jumpTime:0, dodge:0, boostOn:false, steerAngle:0,
    input:{throttle:0,steer:0,boost:false,jump:false,handbrake:false,airRoll:0},
    score:0
  };
}

function makeBall() {
  return { x:0,y:BALL_R+.15,z:0,vx:0,vy:0,vz:0,rx:0,rz:0 };
}

class Match {
  constructor() {
    this.cars=[makeCar(0),makeCar(1)];
    this.ball=makeBall();
    this.scores=[0,0];
    this.pads=BOOSTS.map((p,i)=>({id:i,x:p[0],z:p[1],amount:p[2],respawn:0}));
    this.phase='waiting';
    this.phaseTimer=0;
    this.remaining=MATCH_LENGTH;
    this.winner=-1;
    this.lastTouch=-1;
    this.celebration='';
    this.seq=0;
  }
  start() {
    this.scores=[0,0];
    this.remaining=MATCH_LENGTH;
    this.winner=-1;
    this.pads.forEach(p=>p.respawn=0);
    this.resetKickoff();
    this.phase='countdown';
    this.phaseTimer=3.3;
    this.celebration='';
  }
  resetKickoff() {
    this.ball=makeBall();
    this.cars.forEach((car,index)=>{
      const fresh=makeCar(index);
      fresh.boost = index === 0 || index === 1 ? 70 : 70;
      fresh.score=car.score;
      fresh.input=car.input;
      Object.assign(car,fresh);
    });
    this.lastTouch=-1;
  }
  setInput(index, raw) {
    const c=this.cars[index];
    if(!c || !raw || typeof raw!=='object')return;
    c.input={
      throttle:clamp(Number(raw.throttle)||0,-1,1),
      steer:clamp(Number(raw.steer)||0,-1,1),
      boost:raw.boost===true,
      jump:raw.jump===true,
      handbrake:raw.handbrake===true,
      airRoll:clamp(Number(raw.airRoll)||0,-1,1)
    };
  }
  step(dt, activePlayers=2) {
    dt=clamp(dt,0,1/30);
    this.seq++;
    if(activePlayers<2) {
      this.phase='waiting';
      return;
    }
    if(this.phase==='waiting')this.start();
    if(this.phase==='finished') {
      this.phaseTimer-=dt;
      if(this.phaseTimer<=0)this.start();
      return;
    }
    if(this.phase==='goal') {
      this.phaseTimer-=dt;
      if(this.phaseTimer<=0){this.resetKickoff();this.phase='countdown';this.phaseTimer=3.3;}
      return;
    }
    if(this.phase==='countdown') {
      this.phaseTimer-=dt;
      if(this.phaseTimer<=0) {this.phase='playing';this.phaseTimer=0;}
      return;
    }
    if(this.phase!=='playing')return;
    this.remaining=Math.max(0,this.remaining-dt);
    for(const p of this.pads)p.respawn=Math.max(0,p.respawn-dt);
    for(const car of this.cars)this.moveCar(car,dt);
    this.collideCars(this.cars[0],this.cars[1]);
    this.moveBall(dt);
    for(const car of this.cars){
      this.collideCarBall(car);
      this.pickupBoost(car);
    }
    if(this.remaining<=0) {
      this.phase='finished'; this.phaseTimer=8;
      this.winner=this.scores[0]===this.scores[1]?-1:(this.scores[0]>this.scores[1]?0:1);
      this.celebration=this.winner<0?'DRAW!':(this.winner===0?'BLUE WINS!':'ORANGE WINS!');
    }
  }
  moveCar(c,dt) {
    const input=c.input;
    const onGround=c.grounded;
    const fx=Math.sin(c.yaw), fz=-Math.cos(c.yaw);
    const rx=Math.cos(c.yaw), rz=Math.sin(c.yaw);
    const initialForward=c.vx*fx+c.vz*fz;
    const initialSide=c.vx*rx+c.vz*rz;
    const speed=Math.hypot(c.vx,c.vz);
    const drift=onGround && input.handbrake;
    const boostActive=input.boost && c.boost>0 && (!onGround || input.throttle>=-.1);
    c.boostOn=boostActive;
    if(boostActive)c.boost=Math.max(0,c.boost-32*dt);
    else c.boost=Math.min(100,c.boost+2.2*dt);

    // Turn input is smoothed to prevent instant violent spins. Low-speed steering
    // is gentle, normal-speed steering is precise, and supersonic turns widen.
    const response=onGround?(drift?13:10):3.7;
    c.steerAngle=smooth(c.steerAngle,input.steer,1-Math.exp(-response*dt));
    if(onGround){
      const speedFactor=clamp(Math.abs(initialForward)/12,0,1);
      const highSpeedPenalty=clamp((Math.abs(initialForward)-19)/20,0,.40);
      const turnRate=(.52+1.85*speedFactor)*(1-highSpeedPenalty)*(drift?1.28:1);
      const gear=initialForward < -1.1 ? -1 : 1;
      c.yaw+=c.steerAngle*turnRate*gear*dt;
    }else{
      // Air yaw is available, but won't spin a car as aggressively as ground turning.
      c.yaw+=c.steerAngle*1.35*dt;
    }

    // Re-evaluate local axes after steering so tire force follows the nose.
    const nx=Math.sin(c.yaw),nz=-Math.cos(c.yaw);
    const sx=Math.cos(c.yaw),sz=Math.sin(c.yaw);
    let longitudinal=c.vx*nx+c.vz*nz;
    let lateral=c.vx*sx+c.vz*sz;
    const throttle=input.throttle;
    if(onGround){
      // Opposite throttle brakes *before* shifting into reverse.
      const acceleratingForward=throttle>0;
      const braking=(acceleratingForward && longitudinal < -1) || (throttle<0 && longitudinal>1);
      const engineForce=braking?78:(acceleratingForward?39:25);
      longitudinal+=engineForce*throttle*dt;
      // Drag when coasting slows naturally, with much less drag when pressing gas.
      const rolling= Math.abs(throttle)<.05 && !boostActive ? 1.55 : .24;
      longitudinal*=Math.exp(-rolling*dt);
      if(boostActive)longitudinal+=64*dt;
      longitudinal=clamp(longitudinal,-14,boostActive?37:30);
      // Steering keeps the car going toward where its nose points.
      // The handbrake deliberately lets the tail slide instead of causing a spin.
      const grip=drift?2.1:16;
      lateral*=Math.exp(-grip*dt);
    }else{
      longitudinal+=(3.6*throttle+(boostActive?50*Math.cos(c.pitch):0))*dt;
      lateral*=Math.exp(-.11*dt);
      longitudinal*=Math.exp(-.09*dt);
      if(boostActive)c.vy+=Math.sin(c.pitch)*50*dt;
    }
    c.vx=nx*longitudinal+sx*lateral;
    c.vz=nz*longitudinal+sz*lateral;
    const maxVelocity=onGround?(boostActive?37:30):39;
    const horizontal=Math.hypot(c.vx,c.vz);
    if(horizontal>maxVelocity){c.vx*=maxVelocity/horizontal;c.vz*=maxVelocity/horizontal;}

    const pressed=input.jump&&!c.jumpLock;
    if(pressed){
      if(c.grounded){
        c.vy=10.8;c.grounded=false;c.jumps=1;c.jumpTime=0;c.pitch=0;c.roll=0;
      }else if(c.jumps===1 && c.jumpTime<1.5){
        c.vy=Math.max(c.vy,0)+4.7;
        const dodgeF=clamp(input.throttle,-1,1);
        const dodgeS=clamp(input.steer,-1,1);
        let impulseX=nx*(Math.abs(dodgeF)+Math.abs(dodgeS)<.1?1:dodgeF)+sx*dodgeS;
        let impulseZ=nz*(Math.abs(dodgeF)+Math.abs(dodgeS)<.1?1:dodgeF)+sz*dodgeS;
        const len=norm2(impulseX,impulseZ);
        c.vx+=impulseX/len*13;c.vz+=impulseZ/len*13;
        c.jumps=2;c.dodge=.38;
      }
    }
    c.jumpLock=input.jump;
    if(!c.grounded){
      c.jumpTime+=dt;
      c.vy-=24*dt;
      if(c.dodge>0){c.dodge-=dt;c.pitch-=dt*13;}
      else{
        c.pitch=clamp(c.pitch+input.throttle*1.4*dt,-1.32,1.32);
        c.roll=clamp(c.roll+(input.airRoll||0)*2.2*dt,-Math.PI,Math.PI);
      }
    }else{
      c.vy=0;c.y=.66;
      c.pitch=smooth(c.pitch,0,1-Math.exp(-8*dt));
      c.roll=smooth(c.roll,0,1-Math.exp(-8*dt));
    }
    c.x+=c.vx*dt;c.y+=c.vy*dt;c.z+=c.vz*dt;
    if(c.y<.66){c.y=.66;c.vy=0;c.grounded=true;c.jumps=0;c.dodge=0;c.pitch=0;c.roll=0;}
    if(c.y>12){c.y=12;if(c.vy>0)c.vy*=-.15;}
    if(c.x>SIDE-1.0){c.x=SIDE-1.0;c.vx=Math.min(0,c.vx)*.25;}
    if(c.x<-SIDE+1.0){c.x=-SIDE+1.0;c.vx=Math.max(0,c.vx)*.25;}
    for(const sign of [-1,1]){
      if(c.z*sign>END-1.15){
        const insideGoal=Math.abs(c.x)<GOAL_W/2-1.05 && c.y<GOAL_H-.2;
        const maxZ=insideGoal?END+3.0:END-1.15;
        if(c.z*sign>maxZ){c.z=sign*maxZ;c.vz=-sign*Math.abs(c.vz)*.25;}
      }
    }
  }
  collideCars(a,b){
    if(Math.abs(a.y-b.y)>1.3)return;
    const dx=b.x-a.x,dz=b.z-a.z;
    const distance=norm2(dx,dz);
    if(distance>=3.02)return;
    const nx=dx/distance,nz=dz/distance,correction=(3.02-distance)*.5;
    a.x-=nx*correction;a.z-=nz*correction;
    b.x+=nx*correction;b.z+=nz*correction;
    const rel=(b.vx-a.vx)*nx+(b.vz-a.vz)*nz;
    if(rel<0){const j=-(1+0.55)*rel*.52;
      a.vx-=nx*j;a.vz-=nz*j;
      b.vx+=nx*j;b.vz+=nz*j;
    }
  }
  moveBall(dt){
    const b=this.ball;
    b.vy-=24*dt;
    b.vx*=Math.exp(-.15*dt);
    b.vz*=Math.exp(-.15*dt);
    b.x+=b.vx*dt;b.y+=b.vy*dt;b.z+=b.vz*dt;
    b.rx+=b.vz*dt/BALL_R;
    b.rz-=b.vx*dt/BALL_R;
    if(b.y<BALL_R){b.y=BALL_R;
      if(b.vy<0){b.vy=-b.vy*.72;if(Math.abs(b.vy)<1.25)b.vy=0;}
      b.vx*=Math.exp(-.75*dt);b.vz*=Math.exp(-.75*dt);
    }
    if(b.y>12.5-BALL_R){b.y=12.5-BALL_R;b.vy=-Math.abs(b.vy)*.72;}
    if(b.x>SIDE-BALL_R){b.x=SIDE-BALL_R;b.vx=-Math.abs(b.vx)*.79;}
    if(b.x<-SIDE+BALL_R){b.x=-SIDE+BALL_R;b.vx=Math.abs(b.vx)*.79;}
    const speed=norm2(b.vx,b.vz);
    const total=Math.hypot(b.vx,b.vy,b.vz);
    if(total>MAX_BALL_SPEED){const f=MAX_BALL_SPEED/total;b.vx*=f;b.vy*=f;b.vz*=f;}
    for(const sign of [-1,1]){
      const inGoalMouth=Math.abs(b.x)<GOAL_W/2-BALL_R*.1 && b.y<GOAL_H-BALL_R*.2;
      if(b.z*sign>END+.1 && inGoalMouth){
        const scoringTeam=sign===1?1:0;
        this.scores[scoringTeam]++;
        this.cars[scoringTeam].score++;
        this.phase='goal';this.phaseTimer=2.9;
        this.celebration=sign===1?'ORANGE SCORES!':'BLUE SCORES!';
        return;
      }
      if(b.z*sign>END-BALL_R && !inGoalMouth){
        b.z=sign*(END-BALL_R);
        b.vz=-sign*Math.abs(b.vz)*.78;
      }
      // Bounce against crossbar and goal posts (rounded surfaces).
      for(const xp of [-GOAL_W/2,GOAL_W/2]){
        if(b.y<GOAL_H+.5){
          const dx=b.x-xp,dz=b.z-sign*END;
          const dist=norm2(dx,dz);
          const limit=BALL_R+.3;
          if(dist<limit){
            const nx=dx/dist,nz=dz/dist;
            b.x+=nx*(limit-dist);b.z+=nz*(limit-dist);
            const vn=b.vx*nx+b.vz*nz;
            if(vn<0){b.vx-=(1+.7)*vn*nx;b.vz-=(1+.7)*vn*nz;}
          }
        }
      }
      if(Math.abs(b.z-sign*END)<BALL_R+.25 && Math.abs(b.x)<GOAL_W/2+.25 && Math.abs(b.y-GOAL_H)<BALL_R+.27){
        const dy=b.y-GOAL_H;
        b.y=GOAL_H+Math.sign(dy||1)*(BALL_R+.27);
        b.vy=-b.vy*.6;
      }
    }
  }
  collideCarBall(c){
    const b=this.ball;
    const dx=b.x-c.x,dz=b.z-c.z,dy=b.y-c.y;
    if(Math.abs(dx)>3.6||Math.abs(dz)>3.6||Math.abs(dy)>2.3)return;
    const co=Math.cos(c.yaw),si=Math.sin(c.yaw);
    const lx=dx*co+dz*si;
    const lz=-dx*si+dz*co;
    const qx=clamp(lx,-.99,.99);
    const qz=clamp(lz,-1.69,1.69);
    const qy=clamp(dy,-.57,.57);
    let nxLocal=lx-qx, nzLocal=lz-qz, ny=dy-qy;
    let distance=Math.hypot(nxLocal,nzLocal,ny);
    if(distance>=BALL_R)return;
    if(distance<.001){nxLocal=0;nzLocal=lz<=0?-1:1;ny=.06;distance=1;}
    const nx=(nxLocal*co-nzLocal*si)/distance;
    const nz=(nxLocal*si+nzLocal*co)/distance;
    const ny2=ny/distance;
    const penetration=BALL_R-Math.min(distance,BALL_R);
    b.x+=nx*(penetration+.016);
    b.z+=nz*(penetration+.016);
    b.y=Math.max(BALL_R,b.y+ny2*(penetration+.016));
    const relative=(c.vx-b.vx)*nx+(c.vy-b.vy)*ny2+(c.vz-b.vz)*nz;
    const hit=Math.max(0,relative);
    const extra=c.boostOn?3.9:0;
    const dodge=c.dodge>0?6.5:0;
    const impulse=clamp(hit*1.36+2.9+extra+dodge,0,33);
    b.vx+=nx*impulse;
    b.vy+=ny2*impulse*.85 + (c.grounded?.8:1.15);
    b.vz+=nz*impulse;
    c.vx-=nx*impulse*.045;c.vz-=nz*impulse*.045;
    this.lastTouch=c.id;
    const len=Math.hypot(b.vx,b.vy,b.vz);
    if(len>MAX_BALL_SPEED){const f=MAX_BALL_SPEED/len;b.vx*=f;b.vy*=f;b.vz*=f;}
  }
  pickupBoost(c){
    for(const p of this.pads){
      if(p.respawn<=0 && c.boost<99 && Math.hypot(c.x-p.x,c.z-p.z)<1.95 && c.y<2.5){
        c.boost=Math.min(100,c.boost+p.amount);
        p.respawn=p.amount===100?10:4.5;
      }
    }
  }
  snapshot(){
    return {
      type:'state',phase:this.phase,phaseTimer:Math.max(0,this.phaseTimer),
      remaining:this.remaining,scores:this.scores,winner:this.winner,
      celebration:this.celebration,lastTouch:this.lastTouch,seq:this.seq,
      ball:{...this.ball},
      cars:this.cars.map(c=>({
        id:c.id,x:c.x,y:c.y,z:c.z,yaw:c.yaw,pitch:c.pitch,roll:c.roll,
        vx:c.vx,vy:c.vy,vz:c.vz,boost:c.boost,boostOn:c.boostOn,
        grounded:c.grounded,score:c.score
      })),
      pads:this.pads.map(p=>p.respawn<=0?1:0)
    };
  }
}
module.exports={Match,makeBall,makeCar,WIDTH,LENGTH,GOAL_W,GOAL_H,BALL_R,MATCH_LENGTH};

return module.exports;
})();

const PORT=Number(process.env.PORT)||3000;
const STATIC_FILES={"/index.html":"<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no\" />\n  <meta name=\"theme-color\" content=\"#070e21\" />\n  <meta name=\"description\" content=\"Rocket Rivals: free private 1v1 multiplayer car soccer with boost, jumps, and real physics.\" />\n  <title>ROCKET RIVALS — 1v1 car soccer</title>\n  <link rel=\"stylesheet\" href=\"/style.css\" />\n</head>\n<body>\n  <canvas id=\"game\" aria-label=\"3D Rocket Rivals arena\"></canvas>\n  <div id=\"vignette\"></div>\n  <div id=\"scanlines\"></div>\n\n  <header id=\"topbar\">\n    <div class=\"brand\"><span class=\"brand-icon\">✦</span><span>ROCKET<span class=\"brand-light\">RIVALS</span><small>CAR SOCCER • ONLINE 1v1</small></span></div>\n    <div class=\"right-status\"><span id=\"networkDot\" class=\"status-dot offline\"></span><span id=\"netText\">CONNECTING</span><span class=\"divider-bar\"></span><span id=\"latency\">— ms</span></div>\n  </header>\n\n  <section id=\"scoreboard\" class=\"hidden\" aria-label=\"Game scoreboard\">\n    <div class=\"team team-blue\"><small>BLUE</small><strong id=\"blueScore\">0</strong></div>\n    <div class=\"match-clock\"><span id=\"gameClock\">3:00</span><small id=\"matchStatus\">1V1 RANKLESS</small></div>\n    <div class=\"team team-orange\"><strong id=\"orangeScore\">0</strong><small>ORANGE</small></div>\n  </section>\n\n  <div id=\"floatingMessage\" class=\"hidden\"></div>\n  <div id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n\n  <section id=\"menu\" class=\"menu-overlay\" aria-label=\"Game lobby\">\n    <div class=\"menu-card\">\n      <div class=\"mini-label\"><span class=\"pulse\"></span> MULTIPLAYER ARENA • OPEN</div>\n      <h1>YOUR ARENA.<br/><em>YOUR RULES.</em></h1>\n      <p class=\"subheading\">Rocket-powered cars. One giant ball. First to the goal. Challenge a friend in your own private arena.</p>\n\n      <div id=\"menuHome\">\n        <button id=\"createBtn\" class=\"button primary\"><span class=\"button-art\">✦</span><span>CREATE PRIVATE ROOM</span><span class=\"arrow\">↗</span></button>\n        <div class=\"or-row\"><span></span>OR JOIN YOUR FRIEND<span></span></div>\n        <div class=\"join-row\"><input id=\"codeInput\" maxlength=\"5\" spellcheck=\"false\" autocomplete=\"off\" aria-label=\"Room code\" placeholder=\"ENTER ROOM CODE\" /><button id=\"joinBtn\" class=\"button secondary\">JOIN ROOM →</button></div>\n      </div>\n\n      <div id=\"menuLobby\" class=\"hidden\">\n        <div class=\"lobby-label\">YOUR PRIVATE ROOM</div>\n        <div class=\"code-plate\"><strong id=\"roomCode\">-----</strong><button id=\"copyCode\" class=\"icon-button\" title=\"Copy room code\">⧉</button></div>\n        <button id=\"inviteBtn\" class=\"button primary\"><span>↗</span><span>COPY FRIEND INVITE LINK</span></button>\n        <div class=\"lobby-status\"><span class=\"lobby-spinner\"></span><span id=\"lobbyStatus\">Waiting for player 2 to join...</span></div>\n        <button id=\"leaveBtn\" class=\"text-button\">← LEAVE ROOM</button>\n      </div>\n\n      <div class=\"controls-help\"><div class=\"help-label\">DRIVER'S MANUAL</div><div class=\"controls-grid\"><div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>DRIVE</span></div><div><kbd>SHIFT</kbd><span>BOOST</span></div><div><kbd>SPACE</kbd><span>JUMP / FLIP</span></div><div><kbd>C</kbd><span>BALL CAM</span></div><div><kbd>CTRL</kbd><span>DRIFT</span></div></div></div>\n    </div>\n    <div class=\"menu-aside\"><span class=\"rotating-diamond\">◇</span> v1.1 • BETTER DRIVING • ONLINE 1v1</div>\n  </section>\n\n  <div id=\"inGame\" class=\"hidden\">\n    <div id=\"leftLabel\">YOU <span id=\"teamColor\">BLUE</span></div>\n    <div id=\"roomHUD\">ROOM <span id=\"hudCode\">-----</span><button id=\"hudCopy\" aria-label=\"Copy invite link\">⧉</button></div>\n    <div id=\"tipLine\">WASD DRIVE &nbsp; • &nbsp; SHIFT BOOST &nbsp; • &nbsp; SPACE JUMP / DOUBLE TAP TO FLIP &nbsp; • &nbsp; CTRL DRIFT &nbsp; • &nbsp; Q / E AIR ROLL &nbsp; • &nbsp; C BALL CAM</div>\n    <div id=\"speedometer\"><span id=\"speedNum\">000</span><small>KM/H</small></div>\n    <div id=\"boostMeter\"><div id=\"boostRing\"><span id=\"boostCount\">70</span><small>BOOST</small></div><div class=\"boost-track\"><div id=\"boostFill\"></div></div></div>\n    <div id=\"cameraBadge\">CAR CAM · C TO TOGGLE</div>\n    <div id=\"touchControls\">\n      <div id=\"joystick\" aria-label=\"Touch joystick\"><div id=\"joyKnob\"></div><span class=\"joystick-hint\">DRIVE + STEER</span></div>\n      <div class=\"touch-actions\"><button id=\"driftTouch\" class=\"touch-button touch-drift\">↝<small>DRIFT</small></button><button id=\"boostTouch\" class=\"touch-button touch-boost\">⚡<small>BOOST</small></button><button id=\"jumpTouch\" class=\"touch-button touch-jump\">↑<small>JUMP</small></button></div>\n    </div>\n  </div>\n  <div id=\"orientationTip\">ROTATE YOUR DEVICE FOR THE BEST EXPERIENCE ↻</div>\n  <script src=\"/game.js\"></script>\n</body>\n</html>\n","/style.css":":root{color-scheme:dark;--bg:#070d1c;--blue:#53d8ff;--orange:#ffb047;--text:#f2f8ff;--muted:#a5b5cf}\n*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#050c1b;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:var(--text);-webkit-tap-highlight-color:transparent}\nbutton,input{font:inherit}button{cursor:pointer}#game{position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none}#vignette{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse at center,transparent 24%,rgba(1,4,14,.46) 100%)}#scanlines{position:fixed;inset:0;pointer-events:none;opacity:.16;background:repeating-linear-gradient(0deg,transparent,transparent 3px,#04132a 4px)}.hidden{display:none!important}\n#topbar{position:fixed;top:0;left:0;right:0;z-index:15;display:flex;justify-content:space-between;align-items:center;padding:22px 34px;pointer-events:none}.brand{display:flex;gap:12px;align-items:center;font-size:18px;font-weight:1000;letter-spacing:-.7px;line-height:1}.brand-icon{font-size:32px;line-height:1;color:var(--blue);text-shadow:0 0 20px #4ad2ff;transform:rotate(-21deg)}.brand-light{color:var(--blue)}.brand small{display:block;margin-top:7px;color:#8495ba;font-size:9px;letter-spacing:2px;font-weight:700}.right-status{display:flex;align-items:center;gap:10px;color:#9baecc;font-size:10px;font-weight:850;letter-spacing:1.5px}.status-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#4ff6bc;box-shadow:0 0 12px #4ff6bc}.status-dot.offline{background:#ec657c;box-shadow:0 0 9px #ec657c}.divider-bar{height:12px;border-left:1px solid #3a4a68;margin:0 8px}\n.menu-overlay{z-index:10;position:fixed;inset:0;display:flex;align-items:center;justify-content:flex-start;padding:8vh 0 4vh 9%;background:linear-gradient(90deg,rgba(3,7,19,.89),rgba(3,10,25,.78) 36%,rgba(7,12,28,.1) 85%)}.menu-card{width:min(480px,calc(100vw - 40px));max-height:calc(100vh - 115px);overflow:auto;scrollbar-width:thin}.mini-label{display:flex;gap:10px;align-items:center;color:#7fe4ff;font-size:10px;font-weight:800;letter-spacing:2.3px}.pulse{height:7px;width:7px;background:#5dffc0;border-radius:50%;box-shadow:0 0 0 5px rgba(71,244,162,.09),0 0 10px #5dffc0}h1{font-size:clamp(42px,5vw,75px);line-height:.98;font-weight:950;letter-spacing:-3px;margin:28px 0 18px}h1 em{font-style:normal;color:var(--blue);text-shadow:0 3px 35px #20b8ff33}.subheading{font-size:14px;line-height:1.8;color:#adbbd4;max-width:385px;margin:0 0 31px}.button{border:0;min-height:56px;font-size:11px;font-weight:900;letter-spacing:1.5px;display:flex;align-items:center;justify-content:space-between;padding:0 19px;transition:transform .17s,filter .17s}.button:hover{transform:translateY(-2px);filter:brightness(1.1)}.button:active{transform:translateY(1px)}.button.primary{width:100%;color:#041021;background:linear-gradient(105deg,#73e6ff,#28baff);box-shadow:0 11px 30px #209fff23}.button-art{font-size:23px}.arrow{font-size:20px}.or-row{display:flex;gap:14px;align-items:center;margin:24px 0;color:#8294b4;font-size:10px;font-weight:850;letter-spacing:1.3px}.or-row span{flex:1;border-top:1px solid #45516a70}.join-row{display:flex;gap:8px}.join-row input{width:54%;min-width:0;min-height:53px;outline:none;border:1px solid #52638082;background:#0c1931c9;padding:0 15px;color:white;letter-spacing:2px;font-size:12px;font-weight:800}.join-row input:focus{border-color:#76d6ff}.join-row input::placeholder{color:#7c89a4}.button.secondary{flex:1;min-height:53px;background:#172842;border:1px solid #456184;color:#d9f7ff;justify-content:center;padding:0 13px;white-space:nowrap}.controls-help{border-top:1px solid #3b4c6259;margin-top:30px;padding-top:21px}.help-label,.lobby-label{color:#a7c6de;font-size:10px;font-weight:850;letter-spacing:2px;margin-bottom:12px}.controls-grid{display:flex;gap:22px;flex-wrap:wrap}.controls-grid>div{display:flex;align-items:center;gap:3px}.controls-grid span{font-size:9px;letter-spacing:1px;margin-left:4px;color:#a1adc3;font-weight:750}kbd{background:#1b2b44;border:1px solid #4b5e79;border-bottom:3px solid #42546d;color:#dbeaff;border-radius:3px;font-size:9px;padding:5px 5px;font-weight:800}.menu-aside{position:fixed;bottom:30px;right:38px;font-size:9px;letter-spacing:2px;font-weight:850;color:#9eb2cc;display:flex;align-items:center;gap:11px}.rotating-diamond{font-size:21px;color:#49d2ff}.code-plate{margin:8px 0 14px;padding:9px 14px;display:flex;align-items:center;justify-content:space-between;background:#14243f;border:1px solid #5e9cbe92}.code-plate strong{font-size:clamp(33px,5vw,50px);font-weight:950;letter-spacing:12px;color:#7ee3ff}.icon-button{background:none;border:none;font-size:27px;color:#9feaff}.lobby-status{display:flex;align-items:center;gap:13px;margin:22px 0;font-size:12px;color:#a8c0d6}.lobby-spinner{border:2px solid #355b78;border-top-color:#62dbff;width:17px;height:17px;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.text-button{background:none;border:0;padding:14px 0;color:#9eacc4;letter-spacing:1.2px;font-size:10px;font-weight:800}\n#scoreboard{position:fixed;z-index:5;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:stretch;height:66px;box-shadow:0 12px 55px #02091070;background:#08132bdf;border:1px solid #3b506a80;backdrop-filter:blur(20px)}.team{min-width:102px;display:flex;align-items:center;justify-content:space-around;gap:7px;padding:0 16px}.team-blue{background:linear-gradient(90deg,#0b628a8c,transparent);border-left:3px solid var(--blue)}.team-orange{background:linear-gradient(270deg,#b5662180,transparent);border-right:3px solid var(--orange)}.team small{font-size:11px;font-weight:900;letter-spacing:1px}.team-blue small{color:#7ce0ff}.team-orange small{color:#ffcd96}.team strong{font-weight:950;font-size:38px;font-variant-numeric:tabular-nums}.match-clock{min-width:150px;padding:9px 25px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;border-right:1px solid #ffffff1e;border-left:1px solid #ffffff1e}.match-clock span{font-weight:950;font-size:27px;font-variant-numeric:tabular-nums}.match-clock small{font-size:9px;color:#9db5c7;letter-spacing:1.5px;font-weight:750}\n#floatingMessage{position:fixed;left:50%;top:32%;transform:translate(-50%,-50%);z-index:6;font-size:clamp(40px,7vw,100px);font-weight:1000;white-space:nowrap;letter-spacing:-2px;text-shadow:0 4px 0 #061024,0 0 45px #0aceff85;pointer-events:none;animation:pop .2s ease-out}@keyframes pop{from{opacity:0;transform:translate(-50%,-50%) scale(.6)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}#floatingMessage.orange{color:#ffbb70;text-shadow:0 4px 0 #381d02,0 0 55px #f69c26a0}#floatingMessage.blue{color:#88eaff}#toast{z-index:25;position:fixed;bottom:95px;left:50%;transform:translateX(-50%) translateY(20px);background:#132743ee;color:#d2f3ff;padding:12px 19px;font-size:12px;font-weight:700;border:1px solid #70cfff65;border-radius:4px;opacity:0;pointer-events:none;transition:all .22s}#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}\n#inGame{pointer-events:none}#leftLabel{position:fixed;left:36px;top:96px;font-size:11px;letter-spacing:2px;color:#a4b3c9;font-weight:850}#teamColor{color:#5ddcff;font-weight:950}#roomHUD{position:fixed;top:98px;right:36px;color:#94a9c5;font-size:10px;letter-spacing:1.6px;font-weight:800}#hudCode{color:white;margin-left:8px;letter-spacing:2px}#hudCopy{pointer-events:auto;border:0;background:transparent;color:#b4dfff;font-size:20px;margin-left:9px;cursor:pointer}#tipLine{position:fixed;bottom:19px;left:50%;transform:translateX(-50%);color:#b0bacf;font-size:9px;letter-spacing:1.05px;font-weight:800;white-space:nowrap}#speedometer{position:fixed;bottom:48px;left:36px;display:flex;align-items:baseline;gap:6px}#speedNum{font-size:43px;font-weight:950;letter-spacing:-2px;font-variant-numeric:tabular-nums}#speedometer small{font-size:10px;letter-spacing:1px;color:#9dabc1;font-weight:900}#boostMeter{position:fixed;right:36px;bottom:44px;display:flex;flex-direction:column;gap:12px;align-items:center}#boostRing{background:linear-gradient(130deg,#d97918,#ffa933);width:88px;height:88px;border-radius:50%;box-shadow:0 0 25px #ff952940;display:flex;flex-direction:column;align-items:center;justify-content:center;border:4px solid #ffd58d;color:#101321}#boostRing span{font-size:35px;line-height:1;font-weight:950;font-variant-numeric:tabular-nums}#boostRing small{font-size:9px;font-weight:950;letter-spacing:1px}.boost-track{height:5px;width:100px;background:#4e3b27;overflow:hidden}.boost-track>div{height:100%;background:linear-gradient(90deg,#ffa531,#fff2c4);width:70%;transition:width .06s}#cameraBadge{pointer-events:auto;cursor:pointer;position:fixed;bottom:58px;left:50%;transform:translateX(-50%);background:#0610257a;padding:8px 14px;border:1px solid #7b8db836;font-size:9px;color:#aecbe4;font-weight:850;letter-spacing:1.1px}#touchControls{display:none}\n#orientationTip{display:none}\n@media(max-width:790px){#topbar{padding:14px 17px}.brand{font-size:14px}.brand-icon{font-size:25px}.brand small{font-size:7px;letter-spacing:1.2px}.right-status{font-size:8px;gap:5px}.divider-bar{margin:0 3px}.menu-overlay{padding:95px 21px 40px;background:#040b1dd9;align-items:flex-start}.menu-card{max-height:calc(100vh - 145px)}h1{font-size:clamp(40px,11vw,62px);margin:19px 0 15px}.subheading{font-size:12px;line-height:1.6;margin-bottom:22px}.menu-aside{bottom:16px;right:20px;font-size:7px}.controls-grid{gap:10px}kbd{padding:3px;font-size:8px}.controls-grid span{font-size:8px}.join-row{flex-wrap:wrap}.join-row input{flex:1;min-width:125px}.menu-overlay .button{font-size:10px}#scoreboard{top:10px;height:47px}.team{min-width:67px;padding:0 8px}.team strong{font-size:27px}.team small{font-size:8px}.match-clock{min-width:98px;padding:3px 12px}.match-clock span{font-size:20px}.match-clock small{font-size:7px}#leftLabel{top:68px;left:15px}#roomHUD{top:68px;right:15px}#tipLine{display:none}#speedometer{bottom:8px;left:16px}#speedNum{font-size:28px}#boostMeter{right:20px;bottom:10px}#boostRing{width:60px;height:60px}#boostRing span{font-size:23px}.boost-track{width:60px}#cameraBadge{bottom:7px;font-size:8px}#floatingMessage{top:30%;font-size:50px}}\n@media(pointer:coarse){#touchControls{position:fixed;inset:0;display:block;pointer-events:none}#joystick{position:fixed;left:9%;bottom:13%;width:136px;height:136px;border-radius:50%;border:2px solid #9fccff5f;background:#29537a33;pointer-events:auto;touch-action:none}#joyKnob{position:absolute;width:62px;height:62px;border-radius:50%;background:#a5dfff70;border:2px solid #c4e7ff9b;top:50%;left:50%;transform:translate(-50%,-50%);box-shadow:0 0 20px #48bfff60}.joystick-hint{position:absolute;bottom:-20px;left:0;width:100%;text-align:center;font-size:10px;font-weight:900;letter-spacing:1.3px;color:#98b9d5}.touch-actions{position:fixed;bottom:15%;right:8%;display:flex;align-items:end;gap:18px;pointer-events:auto}.touch-button{width:87px;height:87px;border-radius:50%;border:3px solid #f8dfb7;background:#dd853fbe;color:white;font-weight:950;font-size:29px;touch-action:none;display:flex;align-items:center;justify-content:center;flex-direction:column;box-shadow:0 0 35px #ed934063}.touch-button small{font-size:10px;letter-spacing:1px}.touch-jump{background:#1985bfc8;border-color:#a4eeff}.touch-boost{width:100px;height:100px}.touch-button.active{transform:scale(.93);filter:brightness(1.45)}#boostMeter{bottom:12px;right:15px}#speedometer{bottom:13px;left:15px}#cameraBadge{left:50%;bottom:10px}}\n@media(pointer:coarse) and (orientation:portrait) and (max-width:650px){#orientationTip{display:block;position:fixed;z-index:20;top:77px;right:16px;font-size:9px;letter-spacing:.7px;color:#ffc877;font-weight:800}#joystick{left:7%;bottom:17%;height:115px;width:115px}.touch-actions{right:6%;bottom:20%;gap:9px}.touch-button{height:70px;width:70px}.touch-boost{height:82px;width:82px}}\n@media(max-height:570px){.menu-overlay{padding-top:75px}.menu-card{max-height:calc(100vh - 96px)}h1{font-size:42px;margin:10px 0}.subheading{margin-bottom:13px}.controls-help{margin-top:16px;padding-top:12px}.menu-aside{display:none}#touchControls #joystick{bottom:16%}.touch-actions{bottom:15%}}\n\n/* Extra drift button on touch devices, sized for iPad landscape play. */\n@media(pointer:coarse){.touch-actions{gap:11px}.touch-drift{width:68px;height:68px;font-size:23px;border-color:#baabef;background:#6651bba8}.touch-drift small{font-size:9px}.touch-boost{width:88px;height:88px}.touch-jump{width:80px;height:80px}}\n@media(pointer:coarse) and (max-width:680px){.touch-actions{right:4%;gap:6px}.touch-drift{width:58px;height:58px}.touch-jump{width:64px;height:64px}.touch-boost{width:72px;height:72px}}\n","/game.js":"/* Rocket Rivals — full 3D arena, WebGL graphics, authoritative online physics.\n   No JavaScript graphics packages, CDNs, or external game assets required. */\n(()=>{\n'use strict';\nconst $=id=>document.getElementById(id);\nconst canvas=$('game');\nconst gl=canvas.getContext('webgl',{antialias:true,alpha:false,powerPreference:'high-performance'})||canvas.getContext('experimental-webgl');\nif(!gl){$('toast').textContent='WebGL is not available in this browser.';$('toast').classList.add('show');return;}\nconst PI=Math.PI,TAU=PI*2;\nconst clamp=(v,a,b)=>Math.max(a,Math.min(b,v));\nconst lerp=(a,b,t)=>a+(b-a)*t;\nconst mix=(a,b,t)=>a.map((v,i)=>lerp(v,b[i],t));\nconst rgb=s=>[parseInt(s.slice(1,3),16)/255,parseInt(s.slice(3,5),16)/255,parseInt(s.slice(5,7),16)/255];\nconst C={floor:rgb('#102d35'),stripe:rgb('#123942'),stripe2:rgb('#0d303c'),mark:rgb('#4f96a5'),blue:rgb('#36baff'),blueLite:rgb('#85e5ff'),orange:rgb('#ff8b35'),orangeLite:rgb('#ffd095'),dark:rgb('#061225'),metal:rgb('#152947'),rail:rgb('#26566e'),white:rgb('#e7faff'),black:rgb('#070b16'),tire:rgb('#090d18'),turf:rgb('#123740'),roof:rgb('#4e7090'),glass:rgb('#091b32'),boost:rgb('#eaa344')};\nlet tGlobal=0,resizeW=1,resizeH=1;\nfunction resize(){const ratio=Math.min(1.6,window.devicePixelRatio||1);const w=Math.max(1,Math.floor(canvas.clientWidth*ratio)),h=Math.max(1,Math.floor(canvas.clientHeight*ratio));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}resizeW=w;resizeH=h;gl.viewport(0,0,w,h);}\nwindow.addEventListener('resize',resize);resize();\nconst vs=`attribute vec3 aPos;attribute vec3 aNorm;\nuniform mat4 uModel,uView,uProj;varying vec3 vNormal,vLocal;varying vec3 vWorld;\nvoid main(){vec4 w=uModel*vec4(aPos,1.0);vWorld=w.xyz;vLocal=aPos;vNormal=normalize(mat3(uModel)*aNorm);gl_Position=uProj*uView*w;}`;\nconst fs=`precision mediump float;uniform vec3 uColor;uniform float uEmissive,uMode,uAlpha;varying vec3 vNormal,vLocal,vWorld;\nvoid main(){vec3 n=normalize(vNormal);float lambert=max(0.0,dot(n,normalize(vec3(-0.4,0.88,-0.62))));\n float light=0.48+0.5*lambert;vec3 c=uColor;\n if(uMode>0.5 && uMode<1.5){vec3 p=normalize(vLocal);float seams=abs(sin(atan(p.z,p.x)*6.0))*abs(sin(acos(clamp(p.y,-1.0,1.0))*7.5));float d=smoothstep(.03,.22,seams);c=mix(vec3(.06,.14,.23),vec3(.9,.95,1.0),d);light=0.68+0.35*lambert;}\n if(uMode>1.5){float stripe=sin(vWorld.x*2.8+vWorld.z*1.9);c*=.94+.06*stripe;}\n c=c*light+uColor*uEmissive;gl_FragColor=vec4(c,uAlpha);}`;\nfunction shader(type,src){const sh=gl.createShader(type);gl.shaderSource(sh,src);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(sh));return sh;}\nconst program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vs));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fs));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);\nconst loc={pos:gl.getAttribLocation(program,'aPos'),norm:gl.getAttribLocation(program,'aNorm'),model:gl.getUniformLocation(program,'uModel'),view:gl.getUniformLocation(program,'uView'),proj:gl.getUniformLocation(program,'uProj'),color:gl.getUniformLocation(program,'uColor'),emit:gl.getUniformLocation(program,'uEmissive'),mode:gl.getUniformLocation(program,'uMode'),alpha:gl.getUniformLocation(program,'uAlpha')};\ngl.enableVertexAttribArray(loc.pos);gl.enableVertexAttribArray(loc.norm);gl.enable(gl.DEPTH_TEST);gl.enable(gl.CULL_FACE);gl.clearColor(.013,.025,.055,1);\nfunction mesh(verts,indices){const v=gl.createBuffer(),ind=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,v);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(verts),gl.STATIC_DRAW);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ind);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices),gl.STATIC_DRAW);return {v,ind,n:indices.length};}\nfunction boxMesh(){const v=[],ii=[];const sides=[[[0,0,1],[[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]],[[0,0,-1],[[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]]],[[1,0,0],[[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]]],[[-1,0,0],[[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]]],[[0,1,0],[[-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]]],[[0,-1,0],[[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]]]];for(const [n,p]of sides){const start=v.length/6;for(const q of p)v.push(...q.map(a=>a*.5),...n);ii.push(start,start+1,start+2,start,start+2,start+3);}return mesh(v,ii);}\nfunction sphereMesh(rows=20,cols=30){const v=[],ii=[];for(let r=0;r<=rows;r++){const phi=r*PI/rows;for(let c=0;c<=cols;c++){const theta=c*TAU/cols;const x=Math.sin(phi)*Math.cos(theta),y=Math.cos(phi),z=Math.sin(phi)*Math.sin(theta);v.push(x,y,z,x,y,z);}}for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const a=r*(cols+1)+c,b=a+cols+1;ii.push(a,a+1,b,b,a+1,b+1);}return mesh(v,ii);}\nfunction cylinderMesh(segments=16){const v=[],ii=[];for(let k=0;k<segments;k++){const a=k*TAU/segments,b=(k+1)*TAU/segments;const n=[Math.cos((a+b)*.5),0,Math.sin((a+b)*.5)],base=v.length/6;for(const p of [[Math.cos(a),-.5,Math.sin(a)],[Math.cos(b),-.5,Math.sin(b)],[Math.cos(b),.5,Math.sin(b)],[Math.cos(a),.5,Math.sin(a)]])v.push(...p,...n);ii.push(base,base+2,base+1,base,base+3,base+2);}for(const y of [-.5,.5]){const offset=v.length/6,normal=[0,Math.sign(y),0];v.push(0,y,0,...normal);for(let k=0;k<=segments;k++){const a=k*TAU/segments;v.push(Math.cos(a),y,Math.sin(a),...normal);}for(let k=0;k<segments;k++){if(y>0)ii.push(offset,offset+k+2,offset+k+1);else ii.push(offset,offset+k+1,offset+k+2);}}return mesh(v,ii);}\nfunction ringMesh(segments=40){const v=[],ii=[];for(let i=0;i<=segments;i++){const a=i*TAU/segments;for(const radius of [.97,1.03])v.push(Math.sin(a)*radius,0,Math.cos(a)*radius,0,1,0);if(i<segments){const a=i*2;ii.push(a,a+1,a+2,a+2,a+1,a+3);}}return mesh(v,ii);}\nconst meshes={box:boxMesh(),sphere:sphereMesh(),cyl:cylinderMesh(),ring:ringMesh()};\nfunction identity(){return [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];}\nfunction mul(a,b){const c=new Array(16);for(let j=0;j<4;j++)for(let i=0;i<4;i++)c[j*4+i]=a[i]*b[j*4]+a[i+4]*b[j*4+1]+a[i+8]*b[j*4+2]+a[i+12]*b[j*4+3];return c;}\nfunction translation(x,y,z){const m=identity();m[12]=x;m[13]=y;m[14]=z;return m;}\nfunction scaling(x,y,z){const m=identity();m[0]=x;m[5]=y;m[10]=z;return m;}\nfunction rotY(a){const c=Math.cos(a),s=Math.sin(a);return [c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1];}\nfunction rotX(a){const c=Math.cos(a),s=Math.sin(a);return [1,0,0,0,0,c,s,0,0,-s,c,0,0,0,0,1];}\nfunction rotZ(a){const c=Math.cos(a),s=Math.sin(a);return [c,s,0,0,-s,c,0,0,0,0,1,0,0,0,0,1];}\nfunction M(x=0,y=0,z=0,sx=1,sy=1,sz=1,yaw=0,pitch=0,roll=0){let m=translation(x,y,z);if(yaw)m=mul(m,rotY(yaw));if(pitch)m=mul(m,rotX(pitch));if(roll)m=mul(m,rotZ(roll));return mul(m,scaling(sx,sy,sz));}\nfunction perspective(fov,aspect,near,far){const f=1/Math.tan(fov/2),nf=1/(near-far);return [f/aspect,0,0,0,0,f,0,0,0,0,(far+near)*nf,-1,0,0,2*far*near*nf,0];}\nfunction lookAt(eye,target){let z=[eye[0]-target[0],eye[1]-target[1],eye[2]-target[2]];let n=Math.hypot(...z);z=z.map(q=>q/(n||1));let x=[z[2],0,-z[0]];n=Math.hypot(...x);x=x.map(q=>q/(n||1));const y=[z[1]*x[2]-z[2]*x[1],z[2]*x[0]-z[0]*x[2],z[0]*x[1]-z[1]*x[0]];return [x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-x.reduce((s,p,i)=>s+p*eye[i],0),-y.reduce((s,p,i)=>s+p*eye[i],0),-z.reduce((s,p,i)=>s+p*eye[i],0),1];}\nfunction draw(name,model,color,emit=0,mode=0,alpha=1){const obj=meshes[name];gl.bindBuffer(gl.ARRAY_BUFFER,obj.v);gl.vertexAttribPointer(loc.pos,3,gl.FLOAT,false,24,0);gl.vertexAttribPointer(loc.norm,3,gl.FLOAT,false,24,12);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,obj.ind);gl.uniformMatrix4fv(loc.model,false,new Float32Array(model));gl.uniform3fv(loc.color,color);gl.uniform1f(loc.emit,emit);gl.uniform1f(loc.mode,mode);gl.uniform1f(loc.alpha,alpha);gl.drawElements(gl.TRIANGLES,obj.n,gl.UNSIGNED_SHORT,0);}\nfunction cube(x,y,z,w,h,d,c,e=0){draw('box',M(x,y,z,w,h,d),c,e);}\nfunction bar(x1,y1,z1,x2,y2,z2,r,color,em=.3){const dx=x2-x1,dy=y2-y1,dz=z2-z1;const L=Math.hypot(dx,dy,dz)||1;const pitch=Math.atan2(dy,Math.hypot(dx,dz));const yaw=Math.atan2(dx,-dz);draw('box',M((x1+x2)/2,(y1+y2)/2,(z1+z2)/2,r,r,L,yaw,pitch),color,em);}\nconst WORLD=[];const add=(shape,model,col,emit=0,mode=0)=>WORLD.push([shape,model,col,emit,mode]);\nfunction wbox(x,y,z,sx,sy,sz,col,emit=0){add('box',M(x,y,z,sx,sy,sz),col,emit);}\nfunction wring(x,y,z,r,col,emit=0){add('ring',M(x,y,z,r,1,r),col,emit);}\nfunction wbar(x1,y1,z1,x2,y2,z2,r,col,emit=.2){const dx=x2-x1,dy=y2-y1,dz=z2-z1,len=Math.hypot(dx,dy,dz)||1;add('box',M((x1+x2)/2,(y1+y2)/2,(z1+z2)/2,r,r,len,Math.atan2(dx,-dz),Math.atan2(dy,Math.hypot(dx,dz))),col,emit);}\nfunction buildWorld(){\n wbox(0,-.67,0,130,.7,130,C.dark);wbox(0,-.13,0,34.1,.26,50.1,C.floor);\n for(let i=0;i<10;i++)wbox(0,.004,-22.5+i*5,33.5,.012,4.97,i%2?C.stripe:C.stripe2);\n for(const sign of [-1,1]){\n  wbox(sign*16.4,.034,0,.16,.035,49.7,C.mark,.30);wbox(0,.034,sign*24.15,33.2,.035,.12,C.mark,.28);\n  wbox(sign*17.5,1.5,0,.55,3,51.1,C.metal);wbox(sign*17.0,2.95,0,.30,.18,51,C.blueLite,.5);\n  wbox(sign*19.0,4.0,0,2,2.2,58,C.rail);wbox(sign*21.5,6.0,0,2.5,2,60,C.metal);wbox(sign*24,8.0,0,2.3,2,62,C.rail);\n  for(let i=0;i<12;i++){const z=-26.5+i*4.9;wbox(sign*18.6,4,z,2,.07,.07,i%2?C.blue:C.orange,.6);wbox(sign*21.5,6.9,z,2,.10,.1,i%2?C.orange:C.blue,.38);}\n  // Arena sides contain seamless transparent-look metal panelling and bumpers.\n  for(let z=-22;z<=22;z+=5){wbox(sign*16.96,1.15,z,.13,1.9,.09,C.roof,.2);wbox(sign*16.9,.22,z,.19,.13,4.8,C.blue,.65);}\n }\n wbox(0,.045,0,.09,.038,49.3,C.mark,.15);wbox(0,.05,0,33.1,.02,.095,C.mark,.15);\n wring(0,.045,0,5.35,C.mark,.34);\n wring(0,.048,0,.43,C.white,.4);\n for(const sign of [-1,1]){\n  // centre facing goal outlines and angular kickoff lines\n  wbox(0,.042,sign*13.9,12,.024,.10,C.mark,.15);\n  wbox(0,.044,sign*19.5,17,.025,.12,C.mark,.1);\n  wbox(0,.041,sign*18.9,.10,.02,11,C.mark,.1);\n  wring(0,.046,sign*13,2.3,C.mark,.14);\n }\n for(let side of [-1,1]){\n  const z=side*25,back=side*28.5,col=side===1?C.blue:C.orange;\n  wbox(0,.1,side*26.5,10.6,.14,6,C.dark);\n  wbox(0,4.55,z,11.2,.19,.22,col,.7);\n  for(const x of [-5.42,5.42]){\n   wbox(x,2.25,z,.2,4.55,.25,col,.7);\n   wbar(x,4.55,z,x,4.55,back,.13,col,.35);\n   wbox(x,2.23,back,.13,4.5,.2,C.rail);\n  }\n  wbox(0,4.52,back,11,.12,.17,C.rail);\n  // Back, roof, and side goal net mesh\n  for(let x=-5;x<=5;x+=1){wbar(x,.1,back,x,4.5,back,.028,C.mark,.12);wbar(x,4.49,z,x,4.49,back,.024,C.mark,.12);}\n  for(let y=.5;y<4.5;y+=.62){wbar(-5.4,y,back,5.4,y,back,.028,C.mark,.1);for(let x of [-5.4,5.4])wbar(x,y,z,x,y,back,.025,C.mark,.08);}\n  for(let zz=25.3;zz<=28.5;zz+=.65){for(let x of [-5.4,5.4])wbar(x,.1,side*zz,x,4.49,side*zz,.025,C.mark,.1);}\n  wbox(0,.055,side*25.1,10.4,.01,.2,col,.7);\n  wbox(0,4.48,side*26.85,10.8,.16,3.4,C.metal,.1);\n  wbox(0,2.25,side*29.05,11,.15,4.5,col,.15);\n  wbox(0,.25,side*29.2,9,.24,.19,col,.5);\n  // Stylised score towers around end walls\n  for(let xx of [-13,13]){wbox(xx,5.1,side*27,.75,10,.75,C.metal);wbox(xx,10.2,side*27,1.1,.28,1.1,col,.7);}\n  wbox(0,9.25,side*30,10.2,2.8,.55,C.metal);\n  wbox(0,9.25,side*29.7,8.6,2.0,.06,col,.22);\n }\n for(let xx of [-26,26])for(let zz of [-34,34]){\n  wbox(xx,6.8,zz,.55,13,.55,C.metal);wbox(xx,13.3,zz,4,.36,2.8,C.white,.75);\n }\n for(let i=0;i<5;i++){const x=-13.5+i*6.7;wbox(x,8.8,-36,4.5,.2,2.3,C.rail);wbox(x,8.8,36,4.5,.2,2.3,C.rail);}\n for(const sign of [-1,1])for(let zi=-3;zi<=3;zi++){wbox(sign*28,11.1,zi*8,2.2,.12,3,zi%2?C.blue:C.orange,.2);}\n // Centre arcs of spectators and big steel supports.\n for(let i=0;i<34;i++){\n  const zz=-34+i*2.06;\n  for(let x of [-30,-27,27,30]){\n   const hue=(i%5===0)?C.orange:(i%3===0?C.blue:C.rail);\n   wbox(x,9.2+(Math.abs(x)===30?1.2:0),zz,1.45,.48,.45,hue,.2);\n  }\n }\n}\nbuildWorld();\nconst padPlaces=[[-12,-17,100],[12,17,100],[-12,17,100],[12,-17,100],[-8,0,28],[8,0,28],[0,-12,28],[0,12,28],[-12,-6,28],[12,6,28],[-12,6,28],[12,-6,28]];\nconst padStatic=padPlaces.map(([x,z,qty])=>({x,z,qty}));\nfunction renderPads(pads){for(let i=0;i<padStatic.length;i++){const p=padStatic[i],on=(!pads||pads[i]!==0),r=p.qty===100?1.18:.76;draw('ring',M(p.x,.081,p.z,r,1,r),on?C.boost:C.metal,on?.72:.1);if(on){draw('cyl',M(p.x,.12,p.z,r*.57,.09,r*.57),C.boost,.8);const bob=Math.sin(tGlobal*3+i)*.09;draw('sphere',M(p.x,.46+bob,p.z,p.qty===100?.43:.25,p.qty===100?.43:.25,p.qty===100?.43:.25),C.orangeLite,.65);}else draw('cyl',M(p.x,.08,p.z,r*.4,.05,r*.4),C.metal);}}\nfunction drawBall(b){\n draw('sphere',M(b.x,.037,b.z,1.18,.015,1.18),C.dark);\n draw('ring',M(b.x,.061,b.z,1.16,1,1.16),C.blue,.34);\n let m=mul(translation(b.x,b.y,b.z),mul(rotX(b.rx||0),rotZ(b.rz||0)));\n draw('sphere',mul(m,scaling(1.02,1.02,1.02)),C.white,.15,1);\n draw('sphere',M(b.x,b.y,b.z,.13,.13,.13),C.blue,.5);\n}\nfunction renderCar(c,i){\n const team=i===0?C.blue:C.orange,trim=i===0?C.blueLite:C.orangeLite;\n const x=c.x,y=c.y,z=c.z;\n draw('sphere',M(x,.06,z,2,.07,2.6),C.dark);\n const parent=mul(translation(x,y,z),mul(rotY(-(c.yaw||0)),mul(rotX(c.pitch||0),rotZ(c.roll||0))));\n const part=(shape,px,py,pz,sx,sy,sz,col,glow=0,yaw=0,pitch=0,roll=0)=>draw(shape,mul(parent,M(px,py,pz,sx,sy,sz,yaw,pitch,roll)),col,glow);\n part('box',0,0,0,2.06,.54,3.65,team,.08);\n part('box',0,.21,-.78,1.85,.48,1.65,team,.12);\n part('box',0,.48,.30,1.60,.66,1.65,C.glass,.09);\n part('box',0,.85,.34,1.36,.12,1.23,trim,.18);\n part('box',0,.26,1.28,1.87,.37,.86,C.roof);\n part('box',0,.37,-1.78,1.68,.20,.23,C.roof);\n part('box',0,-.16,-1.9,1.8,.19,.27,C.dark);\n part('box',0,-.30,1.94,1.83,.24,.21,C.metal);\n part('box',0,.6,1.87,2.1,.12,.42,team,.55);\n for(const xx of [-.87,.87]){\n  part('box',xx,.26,-1.82,.30,.16,.1,C.white,.75);\n  part('box',xx,.26,1.91,.29,.16,.08,C.orange,.7);\n  for(const zz of [-1.2,1.18]){\n   part('cyl',xx*1.16,-.31,zz,.66,.37,.66,C.tire,0,0,0,PI/2);\n   part('cyl',xx*1.17,-.31,zz,.28,.39,.28,C.roof,.22,0,0,PI/2);\n  }\n  part('box',xx*1.04,.32,.15,.10,.16,2.4,trim,.35);\n }\n part('box',0,-.04,-1.96,1.1,.09,.12,trim,.35);\n if(c.boostOn){const flick=.8+Math.random()*.4;for(const xx of [-.56,.56]){\n   part('sphere',xx,-.10,2.16,.22,.2,.36,C.orangeLite,.8);\n   part('sphere',xx,-.10,2.4+.45*flick,.14,.13,.75*flick,C.orange,.95);\n }}else{for(const xx of [-.52,.52])part('box',xx,-.07,1.91,.25,.17,.1,C.orange,.25);}\n}\nconst demoCars=[{x:-5,y:.66,z:10,yaw:.24,pitch:0,roll:0,boostOn:false},{x:5,y:.66,z:-10,yaw:PI+.35,pitch:0,roll:0,boostOn:false}];\nlet socket=null,player=-1,room='',joined=false,match=null,lastStateAt=0,lastSeq=0,lastGoals='0:0',lastPhase='waiting';\nlet clockPing=0,connected=false,ballCam=false,deviceMode=false;\nlet desired={throttle:0,steer:0,boost:false,jump:false};\nconst keys=new Set(),touch={throttle:0,steer:0,boost:false,jump:false,handbrake:false,engaged:false};\nlet cameraEye=[0,20,40],cameraTarget=[0,0,0],renderCars=demoCars.map(x=>({...x})),ballDisplay={x:0,y:1.02,z:0,vx:0,vy:0,vz:0,rx:0,rz:0};\nlet toastTimer;\nfunction toast(s){const el=$('toast');el.textContent=s;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3400);}\nfunction network(ok){connected=ok;$('networkDot').classList.toggle('offline',!ok);$('netText').textContent=ok?'ONLINE':'DISCONNECTED';if(!ok)$('latency').textContent='— ms';}\nfunction showLobby(){joined=false;$('menu').classList.remove('hidden');$('inGame').classList.add('hidden');$('scoreboard').classList.add('hidden');$('menuHome').classList.toggle('hidden',!!room);$('menuLobby').classList.toggle('hidden',!room);if(room){$('roomCode').textContent=room;$('lobbyStatus').textContent='Waiting for player 2 to join...';}}\nfunction showGame(){joined=true;$('menu').classList.add('hidden');$('inGame').classList.remove('hidden');$('scoreboard').classList.remove('hidden');$('floatingMessage').classList.remove('hidden');$('leftLabel').innerHTML='YOU <span id=\"teamColor\">'+(player===0?'BLUE':'ORANGE')+'</span>';$('teamColor').style.color=player===0?'#5ddcff':'#ffb567';$('hudCode').textContent=room;toast('MATCH FOUND — LET’S GO!');}\nfunction doSend(data){if(socket&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data));else toast('Not connected. Check your connection.');}\nfunction connect(){const protocol=location.protocol==='https:'?'wss:':'ws:';socket=new WebSocket(protocol+'//'+location.host+'/ws');socket.addEventListener('open',()=>{network(true);clockPing=performance.now();doSend({type:'ping',sent:clockPing});const query=new URLSearchParams(location.search).get('room');if(query){$('codeInput').value=query.toUpperCase();doSend({type:'join',code:query.toUpperCase()});}});\n socket.addEventListener('message',evt=>{let msg;try{msg=JSON.parse(evt.data);}catch{return;}switch(msg.type){\n case 'room':room=msg.code;player=msg.player;showLobby();break;\n case 'peer_joined':showGame();break;\n case 'peer_left':joined=false;showLobby();toast('Opponent left the match. Share your code for a rematch.');break;\n case 'left':room='';player=-1;match=null;history.replaceState(null,'',location.pathname);showLobby();break;\n case 'state':match=msg;lastStateAt=performance.now();lastSeq=msg.seq;updateHud(msg);break;\n case 'pong':$('latency').textContent=Math.round(performance.now()-Number(msg.sent||performance.now()))+' ms';break;\n case 'error':toast(msg.message||'Something went wrong.');break;\n }});\n socket.addEventListener('close',()=>{network(false);joined=false;room='';player=-1;match=null;showLobby();toast('Disconnected from the game server. Reload to reconnect.');});socket.addEventListener('error',()=>network(false));}\nfunction startSound(freq=440,dur=.08,type='sine',volume=.03){try{if(!window.AudioContext&&!window.webkitAudioContext)return;if(!startSound.ctx)startSound.ctx=new (window.AudioContext||window.webkitAudioContext)();const ctx=startSound.ctx;if(ctx.state==='suspended')ctx.resume();const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type=type;osc.frequency.setValueAtTime(freq,ctx.currentTime);osc.frequency.exponentialRampToValueAtTime(Math.max(55,freq*.52),ctx.currentTime+dur);gain.gain.setValueAtTime(volume,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+dur);osc.connect(gain).connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+dur);}catch(e){}}\nfunction updateHud(s){\n $('blueScore').textContent=s.scores[0];$('orangeScore').textContent=s.scores[1];const sec=Math.ceil(s.remaining);$('gameClock').textContent=Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0');\n $('matchStatus').textContent=s.phase==='countdown'?'KICKOFF':s.phase==='playing'?'1V1 ONLINE MATCH':s.phase==='goal'?'GOAL!':s.phase==='finished'?'FULL TIME':'WAITING';\n let msg='',theme='';if(s.phase==='countdown'){const n=Math.ceil(s.phaseTimer);msg=n>0?String(n):'GO!';}else if(s.phase==='goal'){msg=s.celebration;theme=s.celebration.includes('ORANGE')?'orange':'blue';}else if(s.phase==='finished'){msg=s.celebration;theme=s.winner===1?'orange':'blue';}\n const el=$('floatingMessage');el.textContent=msg;el.className=msg?theme:'hidden';\n if(s.phase==='goal'&&lastPhase!=='goal')startSound(740,.55,'sawtooth',.035);\n if(s.phase==='playing'&&lastPhase==='countdown')startSound(560,.18,'triangle',.035);\n lastPhase=s.phase;\n lastGoals=s.scores.join(':');\n}\nfunction updateInput(){let throttle=(keys.has('KeyW')||keys.has('ArrowUp')?1:0)-(keys.has('KeyS')||keys.has('ArrowDown')?1:0);let steer=(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0);if(touch.engaged){throttle=touch.throttle;steer=touch.steer;}\n desired={type:'input',throttle,steer,boost:keys.has('ShiftLeft')||keys.has('ShiftRight')||touch.boost,jump:keys.has('Space')||touch.jump,handbrake:keys.has('ControlLeft')||keys.has('ControlRight')||touch.handbrake,airRoll:(keys.has('KeyE')?1:0)-(keys.has('KeyQ')?1:0)};}\nconst playingKeys=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowLeft','ArrowRight','ArrowDown','ShiftLeft','ShiftRight','Space','KeyC','KeyQ','KeyE','ControlLeft','ControlRight']);\nwindow.addEventListener('keydown',e=>{if(document.activeElement===$('codeInput'))return;if(playingKeys.has(e.code))e.preventDefault();if(e.code==='KeyC'&&!e.repeat){ballCam=!ballCam;$('cameraBadge').textContent=(ballCam?'BALL CAM':'CAR CAM')+' · C TO TOGGLE';}keys.add(e.code);if(e.code==='Space'&&!e.repeat)startSound(170,.08,'square',.008);});\nwindow.addEventListener('keyup',e=>keys.delete(e.code));\nwindow.addEventListener('blur',()=>{keys.clear();touch.throttle=0;touch.steer=0;touch.boost=false;touch.jump=false;touch.handbrake=false;touch.engaged=false;});\n$('createBtn').onclick=()=>{if(!connected){toast('Cannot reach server. Reload the page.');return;}doSend({type:'create'});startSound(540,.12,'triangle',.02);};\n$('joinBtn').onclick=joinRoom;$('codeInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();joinRoom();}};\n$('codeInput').oninput=()=>{$('codeInput').value=$('codeInput').value.toUpperCase().replace(/[^A-Z0-9]/g,'');};\nfunction joinRoom(){const code=$('codeInput').value.trim().toUpperCase();if(code.length!==5){toast('Enter the 5-character room code.');return;}doSend({type:'join',code});}\n$('leaveBtn').onclick=()=>{doSend({type:'leave'});room='';joined=false;match=null;history.replaceState(null,'',location.pathname);showLobby();};\nfunction inviteUrl(){const u=new URL(location.href);u.searchParams.set('room',room);return u.href;}\nasync function copy(what){const value=what==='code'?room:inviteUrl();if(!value)return;try{await navigator.clipboard.writeText(value);toast(what==='code'?'Room code copied!':'Invite link copied!');}catch{prompt('Copy this and send it to your friend:',value);}}\n$('copyCode').onclick=()=>copy('code');$('inviteBtn').onclick=()=>copy('url');$('hudCopy').onclick=()=>copy('url');\n$('cameraBadge').onclick=()=>{ballCam=!ballCam;$('cameraBadge').textContent=(ballCam?'BALL CAM':'CAR CAM')+' · TAP TO TOGGLE';};\n// Mobile two-axis left joystick + thumb-sized right buttons. No external touch library.\nconst joy=$('joystick'),knob=$('joyKnob');let joyPointer=null;\njoy.addEventListener('pointerdown',e=>{e.preventDefault();joyPointer=e.pointerId;joy.setPointerCapture(e.pointerId);touch.engaged=true;moveJoy(e);});\njoy.addEventListener('pointermove',e=>{if(e.pointerId===joyPointer)moveJoy(e);});\nfunction moveJoy(e){const r=joy.getBoundingClientRect(),x=(e.clientX-(r.left+r.width/2))/(r.width*.5),y=(e.clientY-(r.top+r.height/2))/(r.height*.5),m=Math.max(1,Math.hypot(x,y)),sx=x/m,sy=y/m;knob.style.left=(50+sx*31)+'%';knob.style.top=(50+sy*31)+'%';touch.steer=Math.abs(sx)<.11?0:clamp(sx*1.3,-1,1);touch.throttle=sy>.23?clamp(-sy*1.35,-1,0):(sy<-.13?clamp(-sy*1.8,0,1):(Math.abs(sx)>.22?.87:0));}\nfunction releaseJoy(e){if(joyPointer!==e.pointerId)return;joyPointer=null;touch.engaged=false;touch.throttle=touch.steer=0;knob.style.left='50%';knob.style.top='50%';}\njoy.addEventListener('pointerup',releaseJoy);joy.addEventListener('pointercancel',releaseJoy);joy.addEventListener('lostpointercapture',()=>{joyPointer=null;touch.engaged=false;touch.throttle=touch.steer=0;});\nfor(const [id,action]of [['boostTouch','boost'],['jumpTouch','jump'],['driftTouch','handbrake']]){const btn=$(id);btn.addEventListener('pointerdown',e=>{e.preventDefault();btn.setPointerCapture(e.pointerId);touch[action]=true;btn.classList.add('active');if(action==='jump')startSound(200,.08,'square',.008);});for(const ev of ['pointerup','pointercancel','lostpointercapture'])btn.addEventListener(ev,()=>{touch[action]=false;btn.classList.remove('active');});}\nlet lastInput=0,lastPing=0,lastFrame=performance.now();\nfunction frame(now){requestAnimationFrame(frame);const dt=clamp((now-lastFrame)/1000,0,.05);lastFrame=now;tGlobal+=dt;resize();updateInput();\n if(joined&&now-lastInput>33){doSend(desired);lastInput=now;}\n if(connected&&now-lastPing>6500){lastPing=now;doSend({type:'ping',sent:performance.now()});}\n if(match){const lag=clamp((now-lastStateAt)/1000,0,.095);for(let i=0;i<2;i++){\n   const raw=match.cars[i],dst=renderCars[i];if(!raw)continue;\n   for(const k of ['x','y','z']){let val=raw[k]+(raw['v'+k]||0)*lag;dst[k]=lerp(dst[k]??val,val,clamp(dt*17,0,1));}\n   let predictedYaw=raw.yaw;if(i===player&&joined&&raw.grounded){const fwd=raw.vx*Math.sin(raw.yaw)-raw.vz*Math.cos(raw.yaw);const turn=(.52+1.85*clamp(Math.abs(fwd)/12,0,1))*(1-clamp((Math.abs(fwd)-19)/20,0,.40));predictedYaw+=desired.steer*turn*(fwd< -1.1?-1:1)*lag*.6;}let delta=((predictedYaw-(dst.yaw??raw.yaw)+PI)%TAU+TAU)%TAU-PI;dst.yaw=(dst.yaw??raw.yaw)+delta*clamp(dt*22,0,1);\n   dst.pitch=lerp(dst.pitch||0,raw.pitch||0,clamp(dt*17,0,1));dst.roll=lerp(dst.roll||0,raw.roll||0,clamp(dt*17,0,1));dst.boostOn=raw.boostOn;\n }\n for(const k of ['x','y','z','rx','rz']){const val=(match.ball[k]||0)+(k==='x'||k==='y'||k==='z'?(match.ball['v'+k]||0)*lag:0);ballDisplay[k]=lerp(ballDisplay[k]??val,val,clamp(dt*19,0,1));}\n }else{\n   ballDisplay.y=1.1+Math.sin(tGlobal*2.1)*.23;ballDisplay.rx=tGlobal*.25;ballDisplay.rz=tGlobal*.38;\n   renderCars[0].yaw=.24+Math.sin(tGlobal*.4)*.11;\n   renderCars[1].yaw=PI+.35+Math.sin(tGlobal*.45)*.11;\n }\n let eye,look;\n if(joined&&player!==-1){const c=renderCars[player],yaw=c.yaw||0;const fx=Math.sin(yaw),fz=-Math.cos(yaw);\n   const behind=ballCam?10:9.5;\n   eye=[c.x-fx*behind,c.y+4.35,c.z-fz*behind];\n   if(ballCam){const v=[ballDisplay.x-c.x,ballDisplay.y-c.y,ballDisplay.z-c.z];const L=Math.hypot(v[0],v[2])||1;look=[c.x+v[0]*.44,c.y+1.35+Math.max(0,v[1]*.26),c.z+v[2]*.44];if(L>17)look=[ballDisplay.x*.65+c.x*.35,ballDisplay.y*.44+1,ballDisplay.z*.65+c.z*.35];}\n   else look=[c.x+fx*6.5,c.y+1.55,c.z+fz*6.5];\n   if(match&&match.phase==='goal'){eye=[ballDisplay.x+11,11,ballDisplay.z+13];look=[ballDisplay.x,1,ballDisplay.z];}\n }else{eye=[Math.cos(tGlobal*.13)*33,18+Math.sin(tGlobal*.14)*3,Math.sin(tGlobal*.13)*42];look=[0,0,0];}\n const fac=1-Math.exp(-dt*(joined?11.5:1.6));cameraEye=mix(cameraEye,eye,fac);cameraTarget=mix(cameraTarget,look,fac);\n gl.viewport(0,0,resizeW,resizeH);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);\n gl.useProgram(program);gl.uniformMatrix4fv(loc.view,false,new Float32Array(lookAt(cameraEye,cameraTarget)));gl.uniformMatrix4fv(loc.proj,false,new Float32Array(perspective((joined?65:56)*PI/180,resizeW/resizeH,.2,270)));\n for(const [shape,m,c,e,mode]of WORLD)draw(shape,m,c,e,mode);\n renderPads(match?.pads);\n for(let i=0;i<2;i++)renderCar(renderCars[i],i);\n drawBall(ballDisplay);\n if(joined&&match&&player!==-1){const c=match.cars[player];$('boostCount').textContent=Math.round(c.boost);$('boostFill').style.width=clamp(c.boost,0,100)+'%';$('speedNum').textContent=String(Math.round(Math.hypot(c.vx,c.vz)*6.5)).padStart(3,'0');}\n}\ntry{connect();}catch(e){toast('WebSocket connection could not be started.');}\nrequestAnimationFrame(frame);\n})();\n"};
const rooms=new Map();
const connections=new Set();
const MAX_ROOMS=250;
const ROOM_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function roomCode(){
  for(let tries=0;tries<1000;tries++){
    let str='';for(let i=0;i<5;i++)str+=ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
    if(!rooms.has(str))return str;
  }
  throw new Error('Too many rooms');
}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{
  const rawPath=(req.url||'/').split('?')[0];
  if(rawPath==='/health'){
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,rooms:rooms.size}));return;
  }
  let pathname;try{pathname=decodeURIComponent(rawPath)}catch(e){res.writeHead(400);res.end();return;}
  const requested=pathname==='/'?'/index.html':pathname;
  if(!Object.prototype.hasOwnProperty.call(STATIC_FILES,requested)){
    res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found');return;
  }
  const extension=requested.substring(requested.lastIndexOf('.'));
  res.writeHead(200,{'Content-Type':mime[extension]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(STATIC_FILES[requested]);
});
class Peer{
  constructor(socket){
    this.socket=socket;this.buffer=Buffer.alloc(0);this.room=null;this.slot=-1;
    this.closed=false;this.lastSeen=Date.now();this.lastInput=0;
    connections.add(this);
    socket.on('data',data=>this.receive(data));
    socket.on('error',()=>this.close());
    socket.on('end',()=>this.close());
    socket.on('close',()=>this.close());
    socket.setNoDelay(true);
  }
  send(data){
    if(this.closed||!this.socket.writable)return;
    const payload=Buffer.from(JSON.stringify(data));
    let header;
    if(payload.length<126){header=Buffer.from([0x81,payload.length]);}
    else if(payload.length<65536){header=Buffer.alloc(4);header[0]=0x81;header[1]=126;header.writeUInt16BE(payload.length,2);}
    else return;
    try{this.socket.write(Buffer.concat([header,payload]));}catch(e){this.close();}
  }
  ping(){if(!this.closed && this.socket.writable)this.socket.write(Buffer.from([0x89,0]));}
  receive(chunk){
    if(this.closed)return;
    this.lastSeen=Date.now();
    if(this.buffer.length+chunk.length>65536){this.close();return;}
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=2){
      const b0=this.buffer[0],b1=this.buffer[1];
      const opcode=b0&15,masked=(b1&128)!==0;
      let len=b1&127,head=2;
      if(len===126){if(this.buffer.length<4)return;len=this.buffer.readUInt16BE(2);head=4;}
      if(len===127 || len>8192||!masked || (b0&0x70)!==0){this.close();return;}
      if(this.buffer.length<head+4+len)return;
      const mask=this.buffer.subarray(head,head+4);
      const payload=Buffer.from(this.buffer.subarray(head+4,head+4+len));
      for(let i=0;i<len;i++)payload[i]^=mask[i%4];
      this.buffer=this.buffer.subarray(head+4+len);
      if(opcode===8){this.close();return;}
      if(opcode===9){this.socket.write(Buffer.from([0x8a,0]));continue;}
      if(opcode===10)continue;
      if(opcode!==1 || (b0&0x80)===0){this.close();return;}
      let obj;try{obj=JSON.parse(payload.toString('utf8'));}catch(e){continue;}
      this.handle(obj);
    }
  }
  leave(){
    const room=this.room;
    if(!room)return;
    room.players[this.slot]=null;
    this.room=null;this.slot=-1;
    const other=room.players.find(Boolean);
    if(other){
      room.game.phase='waiting';
      other.send({type:'peer_left'});
      room.lastActive=Date.now();
    }else rooms.delete(room.code);
  }
  close(){
    if(this.closed)return;
    this.closed=true;
    this.leave();
    connections.delete(this);
    if(!this.socket.destroyed)this.socket.destroy();
  }
  handle(msg){
    if(!msg||typeof msg!=='object')return;
    if(msg.type==='create'){
      this.leave();
      if(rooms.size>=MAX_ROOMS){this.send({type:'error',message:'All rooms are busy. Please try again later.'});return;}
      const code=roomCode();
      const room={code,players:[this,null],game:new Match(),lastActive:Date.now()};
      rooms.set(code,room);
      this.room=room;this.slot=0;
      this.send({type:'room',code,player:0});
      this.send(room.game.snapshot());
    }else if(msg.type==='join'){
      const code=String(msg.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
      const room=rooms.get(code);
      if(!room){this.send({type:'error',message:'Room not found. Check the code.'});return;}
      if(room.players.every(Boolean) && !room.players.includes(this)){
        this.send({type:'error',message:'Room is full (2 players max).'});return;
      }
      if(this.room===room){this.send({type:'room',code,player:this.slot});return;}
      this.leave();
      const slot=room.players[0]?1:0;
      room.players[slot]=this;this.room=room;this.slot=slot;
      room.lastActive=Date.now();
      this.send({type:'room',code,player:slot});
      room.players.forEach(peer=>peer&&peer.send({type:'peer_joined'}));
      room.game.start();
      room.players.forEach(peer=>peer&&peer.send(room.game.snapshot()));
    }else if(msg.type==='input'&&this.room){
      const now=Date.now();
      if(now-this.lastInput<8)return;
      this.lastInput=now;
      this.room.game.setInput(this.slot,msg);
      this.room.lastActive=now;
    }else if(msg.type==='ping'){
      this.send({type:'pong',sent:msg.sent});
    }else if(msg.type==='leave'){
      this.leave();this.send({type:'left'});
    }
  }
}
server.on('upgrade',(req,socket,head)=>{
  const key=req.headers['sec-websocket-key'];
  if(req.url?.split('?')[0]!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||!key||typeof key!=='string'){
    socket.destroy();return;
  }
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const peer=new Peer(socket);
  if(head.length)peer.receive(head);
});
let lastTick=process.hrtime.bigint(),accumulator=0,steps=0;
const tick=setInterval(()=>{
  const now=process.hrtime.bigint();
  let dt=Number(now-lastTick)/1e9;lastTick=now;
  accumulator+=Math.min(.08,Math.max(0,dt));
  // Fixed-step simulation: catch up at most four 60 Hz frames per scheduler tick.
  const n=Math.min(4,Math.floor(accumulator*60));
  accumulator=Math.max(0,accumulator-n/60);
  if(accumulator>1/30)accumulator=0;
  for(const room of rooms.values()){
    if(room.players[0]&&room.players[1]){
      for(let i=0;i<n;i++)room.game.step(1/60,2);
    }
  }
  steps++;
  if(steps%3===0){
    for(const room of rooms.values()){
      if(room.players.some(Boolean)){
        const packet=room.game.snapshot();
        room.players.forEach(p=>p&&p.send(packet));
      }
    }
  }
},1000/60);
tick.unref();
setInterval(()=>{
  for(const peer of connections){
    if(Date.now()-peer.lastSeen>75000)peer.close();else peer.ping();
  }
  for(const [code,room] of rooms){
    if(!room.players.some(Boolean)||Date.now()-room.lastActive>3600000){
      room.players.forEach(p=>p&&p.close());rooms.delete(code);
    }
  }
},30000).unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`Rocket Rivals ready on http://localhost:${PORT}`));
module.exports={server,rooms};
