/* =========================================================
   LE BRAQUAGE — serveur de parties
   Lance : node serveur.js
   Puis chacun ouvre l'adresse affichée sur son téléphone.
   ========================================================= */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const FICHIER = path.join(__dirname, "le-braquage-multi.html");

/* ---------- règles du jeu (identiques au jeu de cartes) ---------- */
const QTES = {1:8,2:8,3:8,4:7,5:7,6:6,7:5,8:4,9:3,10:4};
// combien d'exemplaires de chaque carte spéciale
const SPECIALES = {
  balance:3, sacperce:3, espion:3, vol:3,
  monteenlair:3,     // gourmandise : deux pioches d'affilée
  complice:2,        // rare : elle sauve tout un sac
  planque:2,         // rare aussi : elle met du butin définitivement à l'abri
  courtcircuit:2,    // rare : elle éteint une alarme
  troc:2             // rare : elle échange deux sacs entiers
};
const NB_ALARMES = 9;
/* objectifs proposés : partie courte, longue, ou soirée entière */
const OBJECTIFS = [100, 300, 500];
function objectifValide(v){ return OBJECTIFS.indexOf(v|0)>=0 ? (v|0) : 100; }
const NOMS_SP = {
  balance:"BALANCE", complice:"COMPLICE", sacperce:"SAC PERCÉ",
  espion:"L'ESPION", vol:"LE VOL", planque:"LA PLANQUE",
  courtcircuit:"LE COURT-CIRCUIT", monteenlair:"MONTE-EN-L'AIR", troc:"LE TROC"
};

function melange(a){
  for(let i=a.length-1;i>0;i--){ const j=crypto.randomInt(i+1); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
/* Le début de manche doit rester respirable : pas d'alarme dans les 6 premières
   cartes, et pas deux alarmes avant la 18e. On remélange tant que ce n'est pas le cas. */
/* Les alarmes ne sont plus jetées au hasard : on leur réserve des emplacements
   espacés. Fini les deux alarmes coup sur coup et les manches expédiées. */
const DEBUT_SUR = 7;    // aucune alarme dans les 7 premières cartes
const ECART_MIN = 6;    // au moins 6 cartes entre deux alarmes

/* Seules les trois premières alarmes décident de la manche : c'est elles
   qu'on place, chacune dans sa fenêtre, avec un écart garanti. */
function entre(min,max){
  if(max<min) max=min;
  return min + crypto.randomInt(max-min+1);
}
/* Plus on est nombreux, plus chacun attend son tour : on allonge donc la manche
   proportionnellement, sinon on ne joue que 4 cartes à dix joueurs. */
function souffle(nbJoueurs){
  return Math.max(1, Math.min(2.2, (nbJoueurs||4)/5));
}
function positionsAlarmes(taille, combien, f){
  f = f || 1;
  const prises=new Set();
  const poser=(p)=>{                       // on pose sans jamais écraser une place déjà prise
    let x=Math.max(0,Math.min(taille-1,p));
    while(prises.has(x) && x<taille-1) x++;
    while(prises.has(x) && x>0) x--;
    prises.add(x);
    return x;
  };
  const ecart=Math.round(ECART_MIN*f);
  const a1=poser(entre(Math.round(DEBUT_SUR*f), Math.round(20*f)));
  const a2=poser(entre(a1+ecart, Math.round(34*f)));
  const a3=poser(entre(a2+ecart, Math.round(48*f)));
  // les six suivantes ne servent que si la manche s'éternise : on les étale
  let curseur=a3;
  for(let i=3;i<combien;i++){
    curseur+=ecart+crypto.randomInt(4);
    curseur=poser(Math.min(curseur,taille-1));
  }
  return [...prises].sort((x,y)=>x-y);
}

function neufPaquet(nbJoueurs){
  const f=souffle(nbJoueurs);
  const reste=[];
  // le butin grossit avec la table : de quoi alimenter les tours supplémentaires
  for(const v in QTES){
    const combien=Math.round(QTES[v]*f);
    for(let i=0;i<combien;i++) reste.push({t:"butin",v:+v});
  }
  // les cartes spéciales suivent aussi, mais les rares restent rares
  for(const k in SPECIALES){
    const rare=(SPECIALES[k]<=2);
    const combien=rare ? SPECIALES[k] : Math.round(SPECIALES[k]*f);
    for(let i=0;i<combien;i++) reste.push({t:"sp",k});
  }
  melange(reste);
  const taille = reste.length + NB_ALARMES;
  const places = positionsAlarmes(taille, NB_ALARMES, f);
  const marque = new Set(places);
  const paquet=[]; let n=0;
  for(let i=0;i<taille;i++) paquet.push(marque.has(i) ? {t:"alarme"} : reste[n++]);
  return paquet;
}
// le sac (en jeu, saisissable) + la planque (déjà à l'abri, même de la police)
const valeur = j => j.sac.reduce((s,c)=>s+c.v,0) + (j.planque||[]).reduce((s,c)=>s+c.v,0);
const valeurSac = j => j.sac.reduce((s,c)=>s+c.v,0);

/* ---------- salons ---------- */
const salons = new Map();
function codeLibre(){
  const L="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do{ c=Array.from({length:4},()=>L[crypto.randomInt(L.length)]).join(""); }
  while(salons.has(c));
  return c;
}

function nouveauSalon(hoteId){
  return {
    code:codeLibre(), hote:hoteId, phase:"salon", cible:100,
    joueurs:[], pioche:[], alarmes:0, tour:0, manche:0,
    solo:false, jetonBot:0,
    premierFuyard:null, evenement:null, apercu:null, classement:null
  };
}
const actifs = s => s.joueurs.filter(j=>j.connecte && !j.fui && !j.pris);

/* Chaque joueur reçoit sa propre vue : sa main lui est réservée, celle des
   autres n'apparaît qu'en nombre de cartes. La pioche n'est jamais envoyée. */
function filtrerEvenement(ev, pourId){
  if(!ev) return null;
  // une carte spéciale piochée reste secrète : les autres voient un dos de carte
  if(ev.type==="speciale" && ev.pour!==pourId){
    return {type:"specialeCachee", nom:ev.nom, pour:ev.pour};
  }
  // les 3 cartes de l'Espion ne sont vues que par lui
  if(ev.type==="espionChoix" && ev.pour!==pourId){
    return {type:"espionAttente", nom:ev.nom, pour:ev.pour, combien:(ev.trois||[]).length};
  }
  return ev;
}
function etatPublic(s, pourId){
  return {
    code:s.code, solo:!!s.solo, phase:s.phase, cible:s.cible, manche:s.manche,
    alarmes:s.alarmes, restantes:s.pioche.length, hote:s.hote,
    tour:s.tour, evenement:filtrerEvenement(s.evenement,pourId),
    apercu:null, classement:s.classement,
    joueurs:s.joueurs.map(j=>({
      id:j.id, nom:j.nom, connecte:j.connecte, total:j.total,
      sac:j.sac,                                   // le butin reste posé sur la table
      planque:j.planque||[],                       // butin déjà à l'abri, hors d'atteinte
      main:(j.id===pourId ? j.main : null),        // la main : secrète
      cartesEnMain:j.main.length,
      fui:j.fui, pris:j.pris, force:j.force
    }))
  };
}
function diffuser(s){
  s.joueurs.forEach(j=>{
    if(j.ws && !j.ws.destroyed && j.ws.writable)
      envoyer(j.ws, JSON.stringify({t:"etat", etat:etatPublic(s,j.id)}));
  });
}
function joueurCourant(s){ return s.joueurs[s.tour]; }

function tourSuivant(s){
  if(!actifs(s).length || !s.pioche.length){ return finManche(s); }
  let n=s.tour, t=0;
  do{ n=(n+1)%s.joueurs.length; t++; }
  while((s.joueurs[n].fui||s.joueurs[n].pris||!s.joueurs[n].connecte) && t<=s.joueurs.length);
  s.tour=n; s.phase="tour"; s.evenement=null;
}

function nouvelleManche(s, premier){
  s.manche++; s.pioche=neufPaquet(s.joueurs.length); s.alarmes=0; s.premierFuyard=null;
  s.evenement=null; s.apercu=null; s.classement=null;
  s.joueurs.forEach(j=>{ j.sac=[]; j.main=[]; j.planque=[]; j.fui=false; j.pris=false; j.force=false; j.rab=0; });
  s.tour = premier % s.joueurs.length;
  if(!s.joueurs[s.tour].connecte) tourSuivant(s);
  s.phase="tour";
}

function finManche(s){
  s.joueurs.forEach(j=>{
    const g = j.pris ? (j.planque||[]).reduce((x,c)=>x+c.v,0) : valeur(j);
    j.gagneManche = g;
    j.total += g;
  });
  s.classement = s.joueurs.slice().sort((a,b)=>b.total-a.total)
    .map(j=>({id:j.id, nom:j.nom, total:j.total, gagne:j.gagneManche||0}));
  const max=s.classement[0].total;
  const exaequo=s.classement.filter(j=>j.total===max).length>1;
  s.phase = (max>=s.cible && !exaequo) ? "victoire" : "finManche";
  s.evenement=null;
}

function police(s){
  const sauves=[], pris=[];
  actifs(s).forEach(j=>{
    const i=j.main.findIndex(c=>c.k==="complice");
    if(i>=0){ j.main.splice(i,1); j.fui=true; sauves.push(j.nom); }
    else { j.pris=true; j.sac=[]; pris.push(j.nom); }   // la planque, elle, reste acquise
  });
  s.phase="police";
  s.evenement={type:"police", pris, sauves};
}

/* ---------- actions ---------- */
function piocher(s, joueur){
  if(s.phase!=="tour" || joueurCourant(s)!==joueur) return;
  const c=s.pioche.shift();
  if(!c){ return finManche(s); }
  joueur.force=false;
  if(c.t==="butin"){
    joueur.sac.push(c);
    s.phase="revele";
    s.evenement={type:"butin", carte:c, pour:joueur.id, nom:joueur.nom};
    return;
  }
  if(c.t==="alarme"){
    s.alarmes++;
    if(s.alarmes>=3){
      s.evenement={type:"alarme", carte:c, rang:3, pour:joueur.id, nom:joueur.nom};
      s.phase="revele";
      s.apercu="police";     // après le « continuer », la police débarque
      return;
    }
    s.phase="revele";
    s.evenement={type:"alarme", carte:c, rang:s.alarmes, pour:joueur.id, nom:joueur.nom};
    return;
  }
  if(c.k==="vol"){
    s.phase="revele";
    s.apercu="vol";
    s.evenement={type:"speciale", carte:c, pour:joueur.id, nom:joueur.nom};
    return;
  }
  joueur.main.push(c);
  s.phase="revele";
  s.evenement={type:"speciale", carte:c, pour:joueur.id, nom:joueur.nom};
}

function continuer(s, joueur){
  if(s.phase!=="revele" || joueurCourant(s)!==joueur) return;
  const suite=s.apercu; s.apercu=null;
  if(!suite && joueur.rab>0 && !joueur.fui && !joueur.pris){
    joueur.rab--;                              // Monte-en-l'air : il rejoue
    s.phase="tour"; s.evenement=null;
    return;
  }
  if(suite==="police"){ return police(s); }
  if(suite==="vol"){
    const cibles=actifs(s).filter(x=>x!==joueur && x.sac.length);
    if(!cibles.length){ return tourSuivant(s); }
    s.phase="vol"; s.evenement={type:"vol", pour:joueur.id, nom:joueur.nom};
    return;
  }
  tourSuivant(s);
}

function ordreEspion(s, joueur, m){
  if(s.phase!=="espion" || joueurCourant(s)!==joueur) return;
  const n=Math.min(3, s.pioche.length);
  const tete=s.pioche.slice(0,n);
  const ordre=(m.ordre||[]).map(i=>i|0).filter(i=>i>=0 && i<n);
  const uniques=[...new Set(ordre)];
  if(uniques.length===n){
    s.pioche = uniques.map(i=>tete[i]).concat(s.pioche.slice(n));
  }
  s.phase="revele"; s.apercu=null;
  s.evenement={type:"espion", nom:joueur.nom, pour:joueur.id};
}

function fuir(s, joueur){
  if(s.phase!=="tour" || joueurCourant(s)!==joueur || joueur.force) return;
  joueur.fui=true;
  if(s.premierFuyard===null) s.premierFuyard=s.joueurs.indexOf(joueur);
  s.phase="revele";
  s.evenement={type:"fuite", pour:joueur.id, nom:joueur.nom, points:valeur(joueur)};
  s.apercu=null;
}

function jouerSpeciale(s, joueur, m){
  if(!(s.phase==="tour"||s.phase==="vol") || joueurCourant(s)!==joueur) return;
  // le Vol demandé par le serveur (effet immédiat)
  if(s.phase==="vol"){
    const cible=s.joueurs.find(x=>x.id===m.cible);
    if(!cible || !cible.sac.length || cible===joueur) return;
    const i=Math.max(0, Math.min(m.carte|0, cible.sac.length-1));
    const volee=cible.sac.splice(i,1)[0];
    joueur.sac.push(volee);
    s.phase="revele"; s.apercu=null;
    s.evenement={type:"vole", carte:volee, nom:joueur.nom, victime:cible.nom, pour:joueur.id};
    return;
  }
  const idx=m.index|0;
  const c=joueur.main[idx];
  if(!c) return;
  if(c.k==="espion"){
    joueur.main.splice(idx,1);
    s.phase="espion"; s.apercu=null;
    s.evenement={type:"espionChoix", trois:s.pioche.slice(0,3), nom:joueur.nom, pour:joueur.id};
    return;
  }
  if(c.k==="vol"){
    const cible=s.joueurs.find(x=>x.id===m.cible);
    if(!cible || !cible.sac.length || cible===joueur) return;
    joueur.main.splice(idx,1);
    const i=Math.max(0, Math.min(m.carte|0, cible.sac.length-1));
    const volee=cible.sac.splice(i,1)[0];
    joueur.sac.push(volee);
    s.phase="revele"; s.apercu=null;
    s.evenement={type:"vole", carte:volee, nom:joueur.nom, victime:cible.nom, pour:joueur.id};
    return;
  }
  if(c.k==="monteenlair"){
    joueur.main.splice(idx,1);
    joueur.rab=2;                              // il rejouera deux fois de suite
    s.phase="revele"; s.apercu=null;
    s.evenement={type:"monteenlair", nom:joueur.nom, pour:joueur.id};
    return;
  }
  if(c.k==="troc"){
    const autre=s.joueurs.find(x=>x.id===m.cible);
    if(!autre || autre===joueur || autre.fui || autre.pris) return;
    joueur.main.splice(idx,1);
    const mien=valeur(joueur), sien=valeur(autre);
    const t=joueur.sac; joueur.sac=autre.sac; autre.sac=t;   // la planque n'est pas échangée
    s.phase="revele"; s.apercu=null;
    s.evenement={type:"troc", nom:joueur.nom, victime:autre.nom, pour:joueur.id,
                 avant:mien, apres:sien};
    return;
  }
  if(c.k==="courtcircuit"){
    if(s.alarmes<=0){ return; }              // rien à éteindre
    joueur.main.splice(idx,1);
    s.alarmes--;
    s.phase="revele"; s.apercu=null;
    s.evenement={type:"courtcircuit", nom:joueur.nom, pour:joueur.id, restantes:s.alarmes};
    return;
  }
  if(c.k==="planque"){
    if(!joueur.sac.length) return;
    const i=Math.max(0, Math.min(m.carte|0, joueur.sac.length-1));
    joueur.main.splice(idx,1);
    const mise=joueur.sac.splice(i,1)[0];
    joueur.planque.push(mise);
    s.phase="revele"; s.apercu=null;
    s.evenement={type:"planque", carte:mise, nom:joueur.nom, pour:joueur.id};
    return;
  }
  const cible=s.joueurs.find(x=>x.id===m.cible);
  if(!cible || cible===joueur || cible.fui || cible.pris) return;
  if(c.k==="balance"){
    joueur.main.splice(idx,1);
    cible.force=true;
    s.phase="revele"; s.apercu=null;
    s.evenement={type:"balance", nom:joueur.nom, victime:cible.nom, pour:joueur.id};
    return;
  }
  if(c.k==="sacperce"){
    if(!cible.sac.length) return;
    joueur.main.splice(idx,1);
    let p=0; cible.sac.forEach((x,n)=>{ if(x.v>cible.sac[p].v) p=n; });
    const perdue=cible.sac.splice(p,1)[0];
    s.phase="revele"; s.apercu=null;
    s.evenement={type:"sacperce", carte:perdue, nom:joueur.nom, victime:cible.nom, pour:joueur.id};
    return;
  }
}

/* =========================================================
   COMPLICES DU TÉLÉPHONE (parties solo)
   Ils jouent avec les mêmes règles, arbitrées ici.
   ========================================================= */
const NOMS_BOTS=["Vito","Nina","Marlo","Suzie","Franck","Lola","Karim","Bébert","Gina"];

function estBot(j){ return !!j.bot; }

function botDecideFuite(s,j){
  const v=valeur(j);
  if(j.force || v===0) return false;
  const restantes=s.pioche.length||1;
  const pAlarme=s.pioche.filter(c=>c.t==="alarme").length/restantes;
  if(s.alarmes===2) return v>=11 || pAlarme>0.16 || Math.random()<0.30;
  if(s.alarmes===1) return v>=20 && Math.random()<0.55;
  return v>=30 && Math.random()<0.40;
}
function botJoueSpeciale(s,j){
  // un complice qui accumule finit par jouer : il ne garde jamais plus de deux cartes
  const trop = j.main.filter(c=>c.k!=="complice").length >= 2;
  // il inspecte la pioche dès la première alarme (les autres cas suivent)
  const es=j.main.findIndex(c=>c.k==="espion");
  if(es>=0 && (trop || (s.alarmes>=1 && Math.random()<0.6))){
    jouerSpeciale(s,j,{index:es});
    return true;
  }
  // éteindre une alarme quand ça chauffe vraiment
  const cc=j.main.findIndex(c=>c.k==="courtcircuit");
  if(cc>=0 && s.alarmes>=2){ jouerSpeciale(s,j,{index:cc}); return true; }
  // planquer sa plus grosse carte quand le sac devient précieux
  const pl=j.main.findIndex(c=>c.k==="planque");
  if(pl>=0 && j.sac.length && (s.alarmes>=1 || valeurSac(j)>=12)){
    let best=0; j.sac.forEach((c,n)=>{ if(c.v>j.sac[best].v) best=n; });
    jouerSpeciale(s,j,{index:pl, carte:best});
    return true;
  }
  // le Troc : quand le sac d'en face est nettement plus garni que le sien
  const tr=j.main.findIndex(c=>c.k==="troc");
  if(tr>=0){
    const proies=actifs(s).filter(x=>x!==j && valeurSac(x)>=valeurSac(j)+9);
    if(proies.length){
      let cible=proies[0];
      proies.forEach(x=>{ if(valeurSac(x)>valeurSac(cible)) cible=x; });
      jouerSpeciale(s,j,{index:tr, cible:cible.id});
      return true;
    }
  }
  // le Monte-en-l'air : tant qu'il n'y a pas d'alarme, on double la mise
  const ml=j.main.findIndex(c=>c.k==="monteenlair");
  if(ml>=0 && (trop || (s.alarmes===0 && Math.random()<0.6))){
    jouerSpeciale(s,j,{index:ml});
    return true;
  }
  // de temps en temps, un mauvais tour au joueur le mieux loti
  const i=j.main.findIndex(c=>c.k==="sacperce"||c.k==="balance");
  if(i<0 || (!trop && Math.random()>0.45)) return false;
  const c=j.main[i];
  const cibles=actifs(s).filter(x=>x!==j && (c.k!=="sacperce"||x.sac.length));
  if(!cibles.length) return false;
  let cible=cibles[0];
  cibles.forEach(x=>{ if(valeur(x)>valeur(cible)) cible=x; });
  jouerSpeciale(s,j,{index:i, cible:cible.id});
  return true;
}

/* Dernier filet : un complice qui a trop de cartes en joue une, quelle qu'elle soit.
   Sans cela il peut en accumuler quatre faute de conditions idéales. */
function botVideSaMain(s,j){
  if(j.main.filter(c=>c.k!=="complice").length < 3) return false;
  const autres=actifs(s).filter(x=>x!==j);
  for(let i=0;i<j.main.length;i++){
    const c=j.main[i];
    if(c.k==="complice") continue;
    if(c.k==="espion" || c.k==="monteenlair"){ jouerSpeciale(s,j,{index:i}); return true; }
    if(c.k==="courtcircuit" && s.alarmes>=1){ jouerSpeciale(s,j,{index:i}); return true; }
    if(c.k==="planque" && j.sac.length){ jouerSpeciale(s,j,{index:i, carte:0}); return true; }
    if(c.k==="vol" || c.k==="sacperce"){
      const proies=autres.filter(x=>x.sac.length);
      if(proies.length){ jouerSpeciale(s,j,{index:i, cible:proies[0].id, carte:0}); return true; }
    }
    if((c.k==="balance"||c.k==="troc") && autres.length){
      jouerSpeciale(s,j,{index:i, cible:autres[0].id}); return true;
    }
  }
  return false;
}
function botAgit(s){
  const j=joueurCourant(s);
  if(!j || !estBot(j)) return;
  if(s.phase==="tour"){
    if(botVideSaMain(s,j)) return;
    if(botJoueSpeciale(s,j)) return;         // la révélation enchaînera
    if(botDecideFuite(s,j)) fuir(s,j); else piocher(s,j);
    return;
  }
  if(s.phase==="revele"){ continuer(s,j); return; }
  if(s.phase==="vol"){
    const cibles=actifs(s).filter(x=>x!==j && x.sac.length);
    if(!cibles.length){ tourSuivant(s); return; }
    let cible=cibles[0];
    cibles.forEach(x=>{ if(valeur(x)>valeur(cible)) cible=x; });
    let meilleure=0;
    cible.sac.forEach((c,n)=>{ if(c.v>cible.sac[meilleure].v) meilleure=n; });
    jouerSpeciale(s,j,{cible:cible.id, carte:meilleure});
    return;
  }
  if(s.phase==="espion"){
    // il place la meilleure carte en premier, l'alarme en dernier
    const n=Math.min(3,s.pioche.length);
    const note=c=>c.t==="alarme"?-100:(c.t==="butin"?c.v:6);
    const ordre=Array.from({length:n},(_,i)=>i).sort((a,b)=>note(s.pioche[b])-note(s.pioche[a]));
    ordreEspion(s,j,{ordre});
    return;
  }
}
/* on programme le coup suivant si c'est à un complice de jouer */
function planifierBot(s){
  if(!s.solo) return;
  const j=joueurCourant(s);
  if(!j || !estBot(j)) return;
  if(["tour","revele","vol","espion"].indexOf(s.phase)<0) return;
  const jeton=++s.jetonBot;
  const delai = s.phase==="revele" ? 1300 : 900;   // le temps de lire l'écran
  setTimeout(()=>{
    if(!salons.has(s.code) || s.jetonBot!==jeton) return;
    botAgit(s);
    diffuser(s);
    planifierBot(s);
  },delai);
}

/* ---------- WebSocket (implémenté sans dépendance) ---------- */
function accepter(req, socket){
  const cle=req.headers["sec-websocket-key"];
  const accept=crypto.createHash("sha1")
    .update(cle+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"+
    "Upgrade: websocket\r\nConnection: Upgrade\r\n"+
    "Sec-WebSocket-Accept: "+accept+"\r\n\r\n");
}
function envoyer(ws, texte){
  const data=Buffer.from(texte,"utf8");
  const len=data.length;
  let entete;
  if(len<126){ entete=Buffer.from([0x81,len]); }
  else if(len<65536){ entete=Buffer.alloc(4); entete[0]=0x81; entete[1]=126; entete.writeUInt16BE(len,2); }
  else { entete=Buffer.alloc(10); entete[0]=0x81; entete[1]=127; entete.writeUInt32BE(0,2); entete.writeUInt32BE(len,6); }
  try{ ws.write(Buffer.concat([entete,data])); }catch(e){}
}
function lireTrames(tampon, surMessage, ws){
  let buf=tampon;
  while(buf.length>=2){
    const opcode=buf[0]&0x0f, masque=(buf[1]&0x80)!==0;
    let len=buf[1]&0x7f, pos=2;
    if(len===126){ if(buf.length<4) break; len=buf.readUInt16BE(2); pos=4; }
    else if(len===127){ if(buf.length<10) break; len=Number(buf.readBigUInt64BE(2)); pos=10; }
    if(buf.length < pos+(masque?4:0)+len) break;
    let cle=null;
    if(masque){ cle=buf.slice(pos,pos+4); pos+=4; }
    const charge=buf.slice(pos,pos+len);
    if(cle) for(let i=0;i<charge.length;i++) charge[i]^=cle[i%4];
    buf=buf.slice(pos+len);
    if(opcode===8){ try{ ws.end(); }catch(e){} return buf; }
    if(opcode===9){ envoyer(ws,""); continue; }
    if(opcode===1){ surMessage(charge.toString("utf8")); }
  }
  return buf;
}

/* ---------- serveur HTTP + jeu ---------- */
const STATIQUES={
  "/manifest.webmanifest":["manifest.webmanifest","application/manifest+json"],
  "/icone-192.png":["icone-192.png","image/png"],
  "/icone-512.png":["icone-512.png","image/png"],
  "/apple-touch-icon.png":["icone-192.png","image/png"]
};

const serveur=http.createServer((req,res)=>{
  const chemin=req.url.split("?")[0];
  if(STATIQUES[chemin]){
    const [nom,type]=STATIQUES[chemin];
    fs.readFile(path.join(__dirname,nom),(e,contenu)=>{
      if(e){ res.writeHead(404); return res.end(); }
      res.writeHead(200,{"Content-Type":type,"Cache-Control":"public, max-age=86400"});
      res.end(contenu);
    });
    return;
  }
  if(req.url==="/" || req.url.startsWith("/?")){
    fs.readFile(FICHIER,(e,contenu)=>{
      if(e){ res.writeHead(500); return res.end("Fichier du jeu introuvable : "+FICHIER); }
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      res.end(contenu);
    });
    return;
  }
  res.writeHead(404); res.end("Rien ici");
});

serveur.on("upgrade",(req,socket)=>{
  accepter(req,socket);
  let tampon=Buffer.alloc(0);
  let salon=null, moi=null;

  const repondre=o=>envoyer(socket,JSON.stringify(o));

  function traiter(texte){
    let m; try{ m=JSON.parse(texte); }catch(e){ return; }

    if(m.t==="creer"){
      const id=crypto.randomUUID();
      salon=nouveauSalon(id);
      moi={id, nom:(m.nom||"Joueur").slice(0,10), ws:socket, connecte:true,
           total:0, sac:[], main:[], planque:[], fui:false, pris:false, force:false};
      salon.joueurs.push(moi);
      salons.set(salon.code,salon);
      repondre({t:"moi", id, code:salon.code});
      return diffuser(salon);
    }

    if(m.t==="solo"){
      const id=crypto.randomUUID();
      salon=nouveauSalon(id);
      salon.solo=true;
      salon.cible=objectifValide(m.cible);
      moi={id, nom:(m.nom||"Toi").slice(0,10), ws:socket, connecte:true,
           total:0, sac:[], main:[], planque:[], fui:false, pris:false, force:false};
      salon.joueurs.push(moi);
      const combien=Math.max(1,Math.min(9, m.bots|0 || 2));
      for(let i=0;i<combien;i++){
        salon.joueurs.push({id:"bot-"+i, nom:NOMS_BOTS[i], bot:true, ws:null, connecte:true,
          total:0, sac:[], main:[], planque:[], fui:false, pris:false, force:false});
      }
      salons.set(salon.code,salon);
      repondre({t:"moi", id, code:salon.code});
      salon.manche=0;
      nouvelleManche(salon,0);
      diffuser(salon);
      planifierBot(salon);
      return;
    }

    if(m.t==="rejoindre"){
      const s=salons.get((m.code||"").toUpperCase().trim());
      if(!s) return repondre({t:"erreur", msg:"Aucune partie avec ce code."});
      if(s.phase!=="salon") return repondre({t:"erreur", msg:"Cette partie a déjà commencé."});
      if(s.joueurs.length>=10) return repondre({t:"erreur", msg:"La table est complète (10 joueurs)."});
      const id=crypto.randomUUID();
      salon=s;
      moi={id, nom:(m.nom||"Joueur").slice(0,10), ws:socket, connecte:true,
           total:0, sac:[], main:[], planque:[], fui:false, pris:false, force:false};
      salon.joueurs.push(moi);
      repondre({t:"moi", id, code:salon.code});
      return diffuser(salon);
    }

    if(!salon || !moi) return;

    switch(m.t){
      case "demarrer":
        if(moi.id!==salon.hote || salon.joueurs.length<2) return;
        salon.cible = objectifValide(m.cible);
        salon.manche=0;
        salon.joueurs.forEach(j=>j.total=0);
        nouvelleManche(salon,0);
        break;
      case "piocher":   piocher(salon,moi); break;
      case "fuir":      fuir(salon,moi); break;
      case "continuer": continuer(salon,moi); break;
      case "speciale":  jouerSpeciale(salon,moi,m); break;
      case "ordre":     ordreEspion(salon,moi,m); break;
      case "mancheSuivante":
        if(salon.phase!=="finManche" && salon.phase!=="police") return;
        if(salon.phase==="police"){ finManche(salon); break; }
        nouvelleManche(salon, salon.premierFuyard===null? salon.tour+1 : salon.premierFuyard);
        break;
      case "rejouer":
        if(moi.id!==salon.hote) return;
        salon.joueurs.forEach(j=>j.total=0);
        salon.manche=0;
        nouvelleManche(salon,0);
        break;
    }
    diffuser(salon);
    planifierBot(salon);
  }

  socket.on("data",d=>{
    tampon=Buffer.concat([tampon,d]);
    tampon=lireTrames(tampon,traiter,socket);
  });

  let parti=false;
  const partir=()=>{
    if(parti) return;            // une seule fois : end, close et error peuvent tous survenir
    parti=true;
    try{ socket.destroy(); }catch(e){}
    if(!salon || !moi) return;
    moi.connecte=false; moi.ws=null;
    if(salon.phase==="salon"){
      salon.joueurs=salon.joueurs.filter(j=>j!==moi);
      if(salon.hote===moi.id && salon.joueurs.length) salon.hote=salon.joueurs[0].id;
    }else if(joueurCourant(salon)===moi && salon.phase==="tour"){
      tourSuivant(salon);           // on ne bloque pas la table sur un joueur parti
    }
    if(salon.solo){ salons.delete(salon.code); return; }
    if(!salon.joueurs.some(j=>j.connecte)) salons.delete(salon.code);
    else diffuser(salon);
  };
  // sur une socket reprise par « upgrade », Node émet « end » mais pas toujours « close »
  socket.on("end",partir);
  socket.on("close",partir);
  socket.on("error",partir);
  socket.setTimeout(0);
});

if(require.main === module){
  serveur.listen(PORT,()=>{
    const nets=require("os").networkInterfaces();
    let ip="localhost";
    for(const n in nets) for(const a of nets[n])
      if(a.family==="IPv4" && !a.internal) ip=a.address;
    console.log("\n  LE BRAQUAGE — serveur démarré\n");
    console.log("  Sur ce réseau, chacun ouvre :  http://"+ip+":"+PORT+"\n");
    console.log("  (Ctrl+C pour arrêter)\n");
  });
}

module.exports = { nouveauSalon, botAgit, planifierBot, nouvelleManche, piocher, fuir, continuer,
                   jouerSpeciale, ordreEspion, finManche, police, etatPublic, valeur, salons };
