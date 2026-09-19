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
  balance:2, sacperce:2, espion:2, vol:2,
  monteenlair:2,     // cartes d'action courantes, mais moins envahissantes
  pickpocket:2,      // demandé : exactement deux Pickpocket par manche
  complice:1,        // très rare : sauve un sac entier de la police
  planque:1,         // rare : met du butin définitivement à l'abri
  courtcircuit:1,    // rare : éteint une alarme
  troc:1,            // rare : échange deux sacs entiers
  rappel:1           // unique : fait revenir un joueur qui avait fui
};
const SPECIALES_ADAPTABLES = new Set(["balance","sacperce","espion","vol","monteenlair"]);
const NB_ALARMES = 9;
/* objectifs proposés : partie courte, longue, ou soirée entière */
const OBJECTIFS = [100, 300, 500];
function objectifValide(v){ return OBJECTIFS.indexOf(v|0)>=0 ? (v|0) : 100; }
const NOMS_SP = {
  balance:"BALANCE", complice:"COMPLICE", sacperce:"SAC PERCÉ",
  espion:"L'ESPION", vol:"LE VOL", planque:"LA PLANQUE",
  courtcircuit:"LE COURT-CIRCUIT", monteenlair:"MONTE-EN-L'AIR", troc:"LE TROC",
  pickpocket:"LE PICKPOCKET", rappel:"LE RAPPEL"
};

function melange(a){
  for(let i=a.length-1;i>0;i--){ const j=crypto.randomInt(i+1); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
/* Le début de manche doit rester respirable : pas d'alarme dans les 6 premières
   cartes, et pas deux alarmes avant la 18e. On remélange tant que ce n'est pas le cas. */
/* Les alarmes ne sont plus jetées au hasard : on leur réserve des emplacements
   espacés. Fini les deux alarmes coup sur coup et les manches expédiées. */
const DEBUT_SUR = 10;   // début plus respirable : l'alarme n'arrive plus presque toujours vers le 6e tour
const ECART_MIN = 7;    // davantage d'air entre les alarmes avant l'escalade de sécurité

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
  const a1=poser(entre(Math.round(DEBUT_SUR*f), Math.round(24*f)));
  const a2=poser(entre(a1+ecart, Math.round(39*f)));
  const a3=poser(entre(a2+ecart, Math.round(55*f)));
  // les six suivantes ne servent que si la manche s'éternise : on les étale
  let curseur=a3;
  for(let i=3;i<combien;i++){
    curseur+=ecart+crypto.randomInt(4);
    curseur=poser(Math.min(curseur,taille-1));
  }
  return [...prises].sort((x,y)=>x-y);
}

function neufPaquet(nbJoueurs, cible){
  const f=souffle(nbJoueurs);
  const reste=[];
  // parties longues : un magot unique, glissé une seule fois dans la manche
  if(cible>=500) reste.push({t:"butin", v:100});
  else if(cible>=300) reste.push({t:"butin", v:50});
  // le butin grossit avec la table : de quoi alimenter les tours supplémentaires
  for(const v in QTES){
    const combien=Math.round(QTES[v]*f);
    for(let i=0;i<combien;i++) reste.push({t:"butin",v:+v});
  }
  // Moins de cartes avantage : seules les actions courantes augmentent légèrement
  // sur les très grandes tables. Pickpocket reste TOUJOURS à 2 par manche.
  for(const k in SPECIALES){
    let combien=SPECIALES[k];
    if(SPECIALES_ADAPTABLES.has(k)) combien=Math.max(2,Math.round(SPECIALES[k]*(0.65+0.35*f)));
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
/* Chaque manche reçoit un paquet entièrement neuf. On mémorise seulement
   l'ouverture précédente pour éviter, même par hasard, de redonner exactement
   la même suite visible au début de deux manches consécutives. */
function signatureOuverture(paquet){
  return paquet.slice(0,12).map(c=>c.t==="butin" ? "b"+c.v : c.t==="sp" ? "s"+c.k : "a").join("|");
}
function paquetNouvelleManche(s){
  let paquet, signature, essais=0;
  do{
    paquet=neufPaquet(s.joueurs.length, s.cible);
    signature=signatureOuverture(paquet);
    essais++;
  }while(s.derniereOuverture && signature===s.derniereOuverture && essais<8);
  s.derniereOuverture=signature;
  return paquet;
}
// le sac (en jeu, saisissable) + la planque (déjà à l'abri, même de la police)
const valeurSacBrute = j => j.sac.reduce((s,c)=>s+c.v,0);
const valeurSac = j => Math.max(0, valeurSacBrute(j) - (j.penalite||0));
const valeur = j => valeurSac(j) + (j.planque||[]).reduce((s,c)=>s+c.v,0);

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
    solo:false, jetonBot:0, messages:[], derniereOuverture:null,
    premierFuyard:null, evenement:null, apercu:null, classement:null,
    historique:[], securiteNiveau:0
  };
}
const actifs = s => s.joueurs.filter(j=>j.connecte && !j.fui && !j.pris);

function journal(s, texte){
  if(!s.historique) s.historique=[];
  s.historique.push({t:Date.now(), texte:String(texte||"")});
  if(s.historique.length>12) s.historique.shift();
}
function niveauSecurite(s){
  const a=actifs(s);
  if(!a.length) return 0;
  const depart=s.nbDepartManche||s.joueurs.length;
  const gros=a.some(j=>valeur(j)>=30);
  if(!gros || a.length>3 || a.length>=depart) return 0;
  return a.length===1 ? 3 : a.length===2 ? 2 : 1;
}
function mettreAJourSecurite(s){
  const nv=niveauSecurite(s);
  if(nv<= (s.securiteNiveau||0)) return false;
  s.securiteNiveau=nv;
  // On ne touche jamais aux 4 prochaines cartes : la difficulté augmente sans piège immédiat.
  const candidats=[];
  for(let i=4;i<s.pioche.length;i++){
    const c=s.pioche[i];
    if(c && c.t==="sp" && c.k!=="rappel") candidats.push(i);
  }
  melange(candidats);
  const convert=Math.min(candidats.length, nv+1);
  for(let k=0;k<convert;k++) s.pioche[candidats[k]]={t:"alarme"};
  // En 1v1 / joueur seul, une alarme supplémentaire est glissée plus loin.
  if(nv>=2 && s.pioche.length>10){
    const pos=Math.min(s.pioche.length-1, 7+crypto.randomInt(Math.min(8,Math.max(1,s.pioche.length-7))));
    s.pioche.splice(pos,0,{t:"alarme"});
  }
  journal(s, nv===1 ? "🚨 Sécurité renforcée : le casse se complique."
                    : nv===2 ? "🚨 Sécurité maximale : il ne reste que deux joueurs."
                             : "🚨 Dernier braqueur : le coffre devient impitoyable.");
  return true;
}
function tickFantomes(s){
  s.joueurs.forEach(j=>{ if((j.fantome||0)>0) j.fantome--; });
}

/* Chaque joueur reçoit sa propre vue : sa main lui est réservée, celle des
   autres n'apparaît qu'en nombre de cartes. La pioche n'est jamais envoyée. */
function filtrerEvenement(ev, pourId){
  if(!ev) return null;
  // une carte spéciale piochée reste secrète : les autres voient un dos de carte
  if(ev.type==="speciale" && ev.pour!==pourId){
    return {type:"specialeCachee", nom:ev.nom, pour:ev.pour};
  }
  // les 3 cartes de l'Espion ne sont vues que par lui
  if(ev.type==="pickpocketCibles" && ev.pour!==pourId){
    return {type:"pickpocketCiblesAttente", nom:ev.nom, pour:ev.pour};
  }
  if(ev.type==="pickpocketChoix" && ev.pour!==pourId){
    return {type:"pickpocketAttente", nom:ev.nom, victime:ev.victime, pour:ev.pour,
            combien:(ev.cartes||[]).length};
  }
  if(ev.type==="pickpocketPris" && ev.pour!==pourId){
    return {type:"pickpocketPrisCache", nom:ev.nom, victime:ev.victime, pour:ev.pour};
  }
  if(ev.type==="espionChoix" && ev.pour!==pourId){
    return {type:"espionAttente", nom:ev.nom, pour:ev.pour, combien:(ev.cartes||[]).length};
  }
  if(ev.type==="fuiteFantome" && ev.pour!==pourId){
    return {type:"butin", carte:ev.fausse, pour:ev.pour, nom:ev.nom, faux:true};
  }
  return ev;
}
function etatPublic(s, pourId){
  return {
    code:s.code, solo:!!s.solo, phase:s.phase, cible:s.cible, manche:s.manche,
    alarmes:s.alarmes, restantes:s.pioche.length, hote:s.hote,
    tour:s.tour, evenement:filtrerEvenement(s.evenement,pourId),
    messages:s.messages||[],
    historique:(s.historique||[]).slice(-5),
    securite:s.securiteNiveau||0,
    apercu:null, classement:s.classement,
    joueurs:s.joueurs.map(j=>({
      id:j.id, nom:j.nom, bot:!!j.bot, connecte:j.connecte, total:j.total,
      sac:j.sac,                                   // le butin reste posé sur la table
      planque:j.planque||[],                       // butin déjà à l'abri, hors d'atteinte
      main:(j.id===pourId ? j.main : null),        // la main : secrète
      cartesEnMain:j.main.length,
      penalite:j.penalite||0,
      fui:(j.fantome>0 && j.id!==pourId ? false : j.fui),
      pris:j.pris, force:j.force
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

/* qui joue après qui, en partant du joueur suivant : sert à l'Espion
   (chaque carte révélée ira à un joueur précis) et à l'affichage de la table */
function ordreDePassage(s, depuis){
  const n=s.joueurs.length, suite=[];
  for(let k=1; k<=n; k++){
    const j=s.joueurs[(depuis+k)%n];
    if(!j.fui && !j.pris && j.connecte) suite.push(j);
  }
  return suite;
}

function tourSuivant(s){
  if(!actifs(s).length || !s.pioche.length){ return finManche(s); }
  let n=s.tour, t=0;
  do{ n=(n+1)%s.joueurs.length; t++; }
  while((s.joueurs[n].fui||s.joueurs[n].pris||!s.joueurs[n].connecte) && t<=s.joueurs.length);
  s.tour=n; tickFantomes(s); s.phase="tour"; s.evenement=null;
}

function nouvelleManche(s, premier){
  s.manche++; s.pioche=paquetNouvelleManche(s); s.alarmes=0; s.premierFuyard=null;
  s.evenement=null; s.apercu=null; s.classement=null; s.historique=[]; s.securiteNiveau=0;
  s.nbDepartManche=s.joueurs.filter(j=>j.connecte).length;
  s.joueurs.forEach(j=>{ j.sac=[]; j.main=[]; j.planque=[]; j.fui=false; j.pris=false; j.force=false;
    j.rab=0; j.reprise=false; j.penalite=0; j.fantome=0; });
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
    if(i>=0){
      j.main.splice(i,1);
      const brut=valeurSacBrute(j), deja=j.penalite||0;
      const net=Math.max(0,brut-deja);
      if(net>30) j.penalite=deja+(net-30); // le Complice protège au maximum 30 pts du sac
      j.fui=true; sauves.push(j.nom);
      journal(s,j.nom+" est sauvé par son Complice (30 pts max protégés).");
    }
    else { j.pris=true; j.sac=[]; j.penalite=0; pris.push(j.nom); }   // la planque, elle, reste acquise
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
    journal(s,joueur.nom+" pioche "+c.v+" point"+(c.v>1?"s":"")+".");
    mettreAJourSecurite(s);
    s.phase="revele";
    s.evenement={type:"butin", carte:c, pour:joueur.id, nom:joueur.nom};
    return;
  }
  if(c.t==="alarme"){
    s.alarmes++;
    const perte=Math.min(valeurSac(joueur), 1+crypto.randomInt(5));
    if(perte>0) joueur.penalite=(joueur.penalite||0)+perte;
    journal(s,joueur.nom+" déclenche l'alarme "+s.alarmes+(perte?" et perd "+perte+" pt"+(perte>1?"s":"")+".":"."));
    if(s.alarmes>=3){
      s.evenement={type:"alarme", carte:c, rang:3, perte, pour:joueur.id, nom:joueur.nom};
      s.phase="revele";
      s.apercu="police";     // après le « continuer », la police débarque
      return;
    }
    s.phase="revele";
    s.evenement={type:"alarme", carte:c, rang:s.alarmes, perte, pour:joueur.id, nom:joueur.nom};
    return;
  }
  if(c.k==="vol"){
    s.phase="revele";
    s.apercu="vol";
    s.evenement={type:"speciale", carte:c, pour:joueur.id, nom:joueur.nom};
    return;
  }
  joueur.main.push(c);
  journal(s,joueur.nom+" trouve une carte spéciale.");
  s.phase="revele";
  s.evenement={type:"speciale", carte:c, pour:joueur.id, nom:joueur.nom};
}

function continuer(s, joueur){
  if(s.phase!=="revele" || joueurCourant(s)!==joueur) return;
  const suite=s.apercu; s.apercu=null;
  // une carte spéciale se joue EN PLUS de son action : on rend la main au joueur,
  // libre à lui de piocher ou de fuir ensuite
  if(!suite && joueur.reprise && !joueur.fui && !joueur.pris){
    joueur.reprise=false;
    s.phase="tour"; s.evenement=null;
    return;
  }
  joueur.reprise=false;
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

function prendreCarte(s, joueur, m){
  if(s.phase!=="pickpocket" || joueurCourant(s)!==joueur) return;
  const proie=s.joueurs.find(x=>x.id===s.evenement.victimeId);
  if(!proie || !proie.main.length){ s.phase="tour"; s.evenement=null; return; }
  const i=Math.max(0, Math.min(m.index|0, proie.main.length-1));
  const prise=proie.main.splice(i,1)[0];
  joueur.main.push(prise);
  s.phase="revele"; s.apercu=null;
  s.evenement={type:"pickpocketPris", pour:joueur.id, nom:joueur.nom,
               victime:proie.nom, carte:prise};
}

function ordreEspion(s, joueur, m){
  if(s.phase!=="espion" || joueurCourant(s)!==joueur) return;
  const vues=(s.evenement && s.evenement.cartes) ? s.evenement.cartes.length : 3;
  const n=Math.min(vues, s.pioche.length);
  const tete=s.pioche.slice(0,n);
  const ordre=(m.ordre||[]).map(i=>i|0).filter(i=>i>=0 && i<n);
  const uniques=[...new Set(ordre)];
  if(uniques.length!==n) return;              // ordre incomplet : on ne valide pas
  s.pioche = uniques.map(i=>tete[i]).concat(s.pioche.slice(n));
  joueur.reprise=true;                        // l'Espion garde réellement la main
  s.phase="revele"; s.apercu=null;
  s.evenement={type:"espion", nom:joueur.nom, pour:joueur.id};
}

function fuir(s, joueur){
  if(s.phase!=="tour" || joueurCourant(s)!==joueur || joueur.force) return;
  joueur.fui=true;
  if(s.premierFuyard===null) s.premierFuyard=s.joueurs.indexOf(joueur);
  journal(s,joueur.nom+" fuit avec "+valeur(joueur)+" pts.");
  mettreAJourSecurite(s);
  s.phase="revele";
  s.evenement={type:"fuite", pour:joueur.id, nom:joueur.nom, points:valeur(joueur)};
  s.apercu=null;
}
function fuirFantome(s,joueur){
  if(s.phase!=="espion" || joueurCourant(s)!==joueur || s.alarmes!==2) return;
  const cartes=(s.evenement&&s.evenement.cartes)||[];
  if(!cartes.some(c=>c.t==="alarme")) return;
  joueur.fui=true; joueur.fantome=2;
  if(s.premierFuyard===null) s.premierFuyard=s.joueurs.indexOf(joueur);
  const fausse={t:"butin",v:1+crypto.randomInt(5)};
  journal(s,joueur.nom+" quitte discrètement le casse.");
  mettreAJourSecurite(s);
  s.phase="revele"; s.apercu=null;
  s.evenement={type:"fuiteFantome", pour:joueur.id, nom:joueur.nom, points:valeur(joueur), fausse};
}

function jouerSpeciale(s, joueur, m){
  if(!(s.phase==="tour"||s.phase==="vol"||s.phase==="pickpocketCible") || joueurCourant(s)!==joueur) return;
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
    // il voit autant de cartes qu'il reste de joueurs dans le coffre :
    // de quoi savoir exactement laquelle lui reviendra
    // il garde la main : la première carte lui reviendra s'il pioche
    const suite=[joueur].concat(ordreDePassage(s, s.tour));
    const nbActifs=actifs(s).length;
    const combien=Math.min(nbActifs===1 ? 3 : Math.max(1,nbActifs), s.pioche.length);
    s.phase="espion"; s.apercu=null;
    s.evenement={type:"espionChoix", cartes:s.pioche.slice(0,combien),
                 pour:joueur.id, nom:joueur.nom,
                 noms:suite.slice(0,combien).map(j=>({id:j.id, nom:j.nom}))};
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
  if(c.k==="pickpocket"){
    // Sur téléphone, le joueur peut d'abord regarder les cartes spéciales de
    // TOUS les adversaires encore en jeu avant de décider qui fouiller.
    if(s.phase==="tour" && !m.cible){
      const cibles=actifs(s).filter(x=>x!==joueur && x.main.length);
      if(!cibles.length) return;
      s.phase="pickpocketCible"; s.apercu=null;
      s.evenement={type:"pickpocketCibles", pour:joueur.id, nom:joueur.nom, index:idx,
        cibles:cibles.map(x=>({id:x.id, nom:x.nom, cartes:x.main.slice()}))};
      return;
    }
    const proie=s.joueurs.find(x=>x.id===m.cible);
    if(!proie || proie===joueur || proie.fui || proie.pris || !proie.main.length) return;
    joueur.main.splice(idx,1);
    s.phase="pickpocket"; s.apercu=null;
    s.evenement={type:"pickpocketChoix", pour:joueur.id, nom:joueur.nom,
                 victime:proie.nom, victimeId:proie.id, cartes:proie.main.slice()};
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
    journal(s,joueur.nom+" coupe une alarme.");
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
  if(c.k==="rappel"){
    const cible=s.joueurs.find(x=>x.id===m.cible);
    if(!cible || cible===joueur || !cible.fui || cible.pris) return;
    joueur.main.splice(idx,1);
    cible.fui=false; cible.fantome=0;
    journal(s,joueur.nom+" fait revenir "+cible.nom+" dans le casse.");
    s.phase="revele"; s.apercu=null;
    s.evenement={type:"rappel", nom:joueur.nom, victime:cible.nom, pour:joueur.id};
    return;
  }
  const cible=s.joueurs.find(x=>x.id===m.cible);
  if(!cible || cible===joueur || cible.fui || cible.pris) return;
  if(c.k==="balance"){
    joueur.main.splice(idx,1);
    cible.force=true;
    joueur.reprise=true;        // seule la Balance laisse le choix : piocher ou fuir
    s.phase="revele"; s.apercu=null;
    journal(s,joueur.nom+" joue Balance sur "+cible.nom+".");
    s.evenement={type:"balance", nom:joueur.nom, victime:cible.nom, pour:joueur.id};
    return;
  }
  if(c.k==="sacperce"){
    if(!cible.sac.length) return;
    joueur.main.splice(idx,1);
    let p=0; cible.sac.forEach((x,n)=>{ if(x.v>cible.sac[p].v) p=n; });
    const perdue=cible.sac.splice(p,1)[0];
    s.phase="revele"; s.apercu=null;
    journal(s,joueur.nom+" perce le sac de "+cible.nom+".");
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

function botAudace(j){
  // Profil stable par complice : certains sont prudents, d'autres franchement casse-cou.
  const txt=(j.id||"")+"|"+(j.nom||""); let h=0;
  for(let i=0;i<txt.length;i++) h=(h*31+txt.charCodeAt(i))%997;
  return h/996; // 0 = prudent, 1 = très audacieux
}
function botDecideFuite(s,j){
  const v=valeur(j);
  if(j.force || v===0) return false;
  const a=botAudace(j);
  // L'IA ne triche plus en regardant la composition réelle de la pioche.
  // Même avec deux alarmes elle peut choisir de rester et donc se faire prendre.
  let seuil, chance;
  if(s.alarmes===2){ seuil=Math.round(18+18*a); chance=0.62-0.28*a; }
  else if(s.alarmes===1){ seuil=Math.round(30+20*a); chance=0.38-0.18*a; }
  else { seuil=Math.round(42+24*a); chance=0.24-0.12*a; }
  return v>=seuil && Math.random()<chance;
}
function botJoueSpeciale(s,j){
  // Une IA ne joue plus chaque carte au moment parfaitement optimal.
  const trop = j.main.filter(c=>c.k!=="complice").length >= 4;

  const es=j.main.findIndex(c=>c.k==="espion");
  if(es>=0 && (trop ? Math.random()<0.60 : (s.alarmes>=1 && Math.random()<0.32))){
    jouerSpeciale(s,j,{index:es}); return true;
  }

  const cc=j.main.findIndex(c=>c.k==="courtcircuit");
  if(cc>=0 && s.alarmes>=2 && Math.random()<0.55){
    jouerSpeciale(s,j,{index:cc}); return true;
  }

  const pl=j.main.findIndex(c=>c.k==="planque");
  if(pl>=0 && j.sac.length && (s.alarmes>=1 || valeurSac(j)>=16) && Math.random()<0.45){
    // pas toujours la meilleure carte : l'IA peut faire un choix moyen
    const ordre=j.sac.map((c,n)=>n).sort((a,b)=>j.sac[b].v-j.sac[a].v);
    const choix=ordre[Math.min(ordre.length-1, crypto.randomInt(Math.min(3,ordre.length)))];
    jouerSpeciale(s,j,{index:pl, carte:choix}); return true;
  }

  const tr=j.main.findIndex(c=>c.k==="troc");
  if(tr>=0 && Math.random()<0.45){
    const proies=actifs(s).filter(x=>x!==j && valeurSac(x)>=valeurSac(j)+6);
    if(proies.length){
      const cible=proies[crypto.randomInt(proies.length)];
      jouerSpeciale(s,j,{index:tr, cible:cible.id}); return true;
    }
  }

  const pp=j.main.findIndex(c=>c.k==="pickpocket");
  if(pp>=0 && Math.random()<0.48){
    const cibles=actifs(s).filter(x=>x!==j && x.main.length);
    if(cibles.length){
      const cible=cibles[crypto.randomInt(cibles.length)];
      jouerSpeciale(s,j,{index:pp, cible:cible.id}); return true;
    }
  }

  const ml=j.main.findIndex(c=>c.k==="monteenlair");
  if(ml>=0 && (trop ? Math.random()<0.45 : (s.alarmes===0 && Math.random()<0.30))){
    jouerSpeciale(s,j,{index:ml}); return true;
  }
  const rp=j.main.findIndex(c=>c.k==="rappel");
  if(rp>=0 && Math.random()<0.45){
    const partis=s.joueurs.filter(x=>x!==j && x.fui && !x.pris);
    if(partis.length){ const x=partis[crypto.randomInt(partis.length)]; jouerSpeciale(s,j,{index:rp,cible:x.id}); return true; }
  }

  const i=j.main.findIndex(c=>c.k==="sacperce"||c.k==="balance");
  if(i<0 || (!trop && Math.random()>0.30)) return false;
  const c=j.main[i];
  const cibles=actifs(s).filter(x=>x!==j && (c.k!=="sacperce"||x.sac.length));
  if(!cibles.length) return false;
  const cible=cibles[crypto.randomInt(cibles.length)];
  jouerSpeciale(s,j,{index:i, cible:cible.id});
  return true;
}

/* Si une IA accumule vraiment beaucoup de cartes, elle finit par en jouer une,
   mais seulement à partir de quatre : elle peut donc aussi gaspiller des occasions. */
function botVideSaMain(s,j){
  if(j.main.filter(c=>c.k!=="complice").length < 4) return false;
  const autres=actifs(s).filter(x=>x!==j);
  const options=[];
  for(let i=0;i<j.main.length;i++){
    const c=j.main[i]; if(c.k==="complice") continue;
    if(c.k==="espion" || c.k==="monteenlair") options.push(()=>jouerSpeciale(s,j,{index:i}));
    else if(c.k==="courtcircuit" && s.alarmes>=1) options.push(()=>jouerSpeciale(s,j,{index:i}));
    else if(c.k==="planque" && j.sac.length) options.push(()=>jouerSpeciale(s,j,{index:i,carte:crypto.randomInt(j.sac.length)}));
    else if((c.k==="vol"||c.k==="sacperce") && autres.some(x=>x.sac.length)){
      options.push(()=>{ const p=autres.filter(x=>x.sac.length); const x=p[crypto.randomInt(p.length)]; jouerSpeciale(s,j,{index:i,cible:x.id,carte:crypto.randomInt(x.sac.length)}); });
    } else if((c.k==="balance"||c.k==="troc") && autres.length){
      options.push(()=>{ const x=autres[crypto.randomInt(autres.length)]; jouerSpeciale(s,j,{index:i,cible:x.id}); });
    } else if(c.k==="pickpocket" && autres.some(x=>x.main.length)){
      options.push(()=>{ const p=autres.filter(x=>x.main.length); const x=p[crypto.randomInt(p.length)]; jouerSpeciale(s,j,{index:i,cible:x.id}); });
    } else if(c.k==="rappel" && s.joueurs.some(x=>x!==j && x.fui && !x.pris)){
      options.push(()=>{ const p=s.joueurs.filter(x=>x!==j && x.fui && !x.pris); const x=p[crypto.randomInt(p.length)]; jouerSpeciale(s,j,{index:i,cible:x.id}); });
    }
  }
  if(!options.length) return false;
  options[crypto.randomInt(options.length)](); return true;
}
function botAgit(s){
  const j=joueurCourant(s);
  if(!j || !estBot(j)) return;
  if(s.phase==="tour"){
    if(botVideSaMain(s,j)) return;
    if(botJoueSpeciale(s,j)) return;
    if(botDecideFuite(s,j)) fuir(s,j); else piocher(s,j);
    return;
  }
  if(s.phase==="revele"){ continuer(s,j); return; }
  if(s.phase==="vol"){
    const cibles=actifs(s).filter(x=>x!==j && x.sac.length);
    if(!cibles.length){ tourSuivant(s); return; }
    const cible=cibles[crypto.randomInt(cibles.length)];
    const carte=crypto.randomInt(cible.sac.length); // plus de vol systématique de la meilleure carte
    jouerSpeciale(s,j,{cible:cible.id, carte});
    return;
  }
  if(s.phase==="pickpocket"){
    prendreCarte(s,j,{index:crypto.randomInt(Math.max(1,(s.evenement.cartes||[]).length))});
    return;
  }
  if(s.phase==="pickpocketCible"){
    const c=(s.evenement&&s.evenement.cibles)||[];
    if(!c.length){ s.phase="tour"; s.evenement=null; return; }
    const x=c[crypto.randomInt(c.length)];
    jouerSpeciale(s,j,{index:s.evenement.index|0,cible:x.id});
    return;
  }
  if(s.phase==="espion"){
    const n=Math.min((s.evenement&&s.evenement.cartes||[]).length||1,s.pioche.length);
    let ordre=Array.from({length:n},(_,i)=>i);
    if(Math.random()<0.35 && n>1){
      // Parfois un bon coup, mais pas un tri parfait de toute la pioche.
      const note=c=>c.t==="alarme"?-30:(c.t==="butin"?c.v:5);
      let best=0;
      for(let k=1;k<n;k++) if(note(s.pioche[k])>note(s.pioche[best])) best=k;
      ordre=ordre.filter(x=>x!==best); melange(ordre); ordre.unshift(best);
    }else melange(ordre);
    ordreEspion(s,j,{ordre});
    return;
  }
}
/* on programme le coup suivant si c'est à un complice de jouer */
function planifierBot(s){
  if(!s.joueurs.some(estBot)) return;   // solo comme multijoueur : dès qu'il y a un complice
  const j=joueurCourant(s);
  if(!j || !estBot(j)) return;
  if(["tour","revele","vol","espion","pickpocket","pickpocketCible"].indexOf(s.phase)<0) return;
  const jeton=++s.jetonBot;
  const delai = s.phase==="revele" ? 2300 : 1700;   // rythme volontairement plus lisible pour suivre la partie
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
  "/sw.js":["sw.js","text/javascript"],
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
      moi={id, jeton:crypto.randomUUID(), nom:(m.nom||"Joueur").slice(0,10), ws:socket, connecte:true,
           total:0, sac:[], main:[], planque:[], fui:false, pris:false, force:false};
      salon.joueurs.push(moi);
      salons.set(salon.code,salon);
      repondre({t:"moi", id, code:salon.code, jeton:moi.jeton});
      return diffuser(salon);
    }

    if(m.t==="solo"){
      const id=crypto.randomUUID();
      salon=nouveauSalon(id);
      salon.solo=true;
      salon.cible=objectifValide(m.cible);
      moi={id, jeton:crypto.randomUUID(), nom:(m.nom||"Toi").slice(0,10), ws:socket, connecte:true,
           total:0, sac:[], main:[], planque:[], fui:false, pris:false, force:false};
      salon.joueurs.push(moi);
      const combien=Math.max(1,Math.min(9, m.bots|0 || 2));
      for(let i=0;i<combien;i++){
        salon.joueurs.push({id:"bot-"+i, nom:NOMS_BOTS[i], bot:true, ws:null, connecte:true,
          total:0, sac:[], main:[], planque:[], fui:false, pris:false, force:false});
      }
      salons.set(salon.code,salon);
      repondre({t:"moi", id, code:salon.code, jeton:moi.jeton});
      salon.manche=0;
      nouvelleManche(salon,0);
      diffuser(salon);
      planifierBot(salon);
      return;
    }


    /* Reprise d'une session après mise en arrière-plan / changement d'application.
       Le jeton privé empêche un autre téléphone de prendre la place du joueur. */
    if(m.t==="reprendre"){
      const s=salons.get((m.code||"").toUpperCase().trim());
      if(!s) return repondre({t:"erreur", reprise:true, msg:"Cette partie n'existe plus."});
      const j=s.joueurs.find(x=>!x.bot && x.id===m.id && x.jeton && x.jeton===m.jeton);
      if(!j) return repondre({t:"erreur", reprise:true, msg:"Impossible de reprendre cette place."});

      salon=s; moi=j;
      if(moi._retraitTimer){ clearTimeout(moi._retraitTimer); moi._retraitTimer=null; }
      if(moi._tourTimer){ clearTimeout(moi._tourTimer); moi._tourTimer=null; }
      if(salon._videTimer){ clearTimeout(salon._videTimer); salon._videTimer=null; }
      if(moi.ws && moi.ws!==socket){ try{ moi.ws.destroy(); }catch(e){} }
      moi.ws=socket;
      moi.connecte=true;
      repondre({t:"moi", id:moi.id, code:salon.code, jeton:moi.jeton, reprise:true});
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
      moi={id, jeton:crypto.randomUUID(), nom:(m.nom||"Joueur").slice(0,10), ws:socket, connecte:true,
           total:0, sac:[], main:[], planque:[], fui:false, pris:false, force:false};
      salon.joueurs.push(moi);
      repondre({t:"moi", id, code:salon.code, jeton:moi.jeton});
      return diffuser(salon);
    }

    if(!salon || !moi) return;

    if(m.t==="quitter"){
      const s=salon, j=moi;
      j.jeton=null;
      j.connecte=false;
      j.ws=null;
      if(j._retraitTimer){ clearTimeout(j._retraitTimer); j._retraitTimer=null; }
      if(j._tourTimer){ clearTimeout(j._tourTimer); j._tourTimer=null; }
      if(s.phase==="salon"){
        s.joueurs=s.joueurs.filter(x=>x!==j);
        if(s.hote===j.id && s.joueurs.length){
          const prochain=s.joueurs.find(x=>!x.bot && x.connecte) || s.joueurs.find(x=>!x.bot) || s.joueurs[0];
          if(prochain) s.hote=prochain.id;
        }
      }else if(s.phase==="tour" && joueurCourant(s)===j){
        tourSuivant(s);
      }
      const humainConnecte=s.joueurs.some(x=>!x.bot && x.connecte);
      if(!humainConnecte) salons.delete(s.code);
      else { diffuser(s); planifierBot(s); }
      salon=null; moi=null;
      return;
    }

    switch(m.t){
      case "ajouterBot": {
        if(moi.id!==salon.hote || salon.phase!=="salon") return;
        if(salon.joueurs.length>=10) return;
        const pris=salon.joueurs.filter(j=>j.bot).map(j=>j.nom);
        const libre=NOMS_BOTS.find(n=>pris.indexOf(n)<0);
        if(!libre) return;
        salon.joueurs.push({id:"bot-"+crypto.randomUUID().slice(0,8), nom:libre, bot:true,
          ws:null, connecte:true, total:0, sac:[], main:[], planque:[],
          fui:false, pris:false, force:false, rab:0});
        break;
      }
      case "retirerBot": {
        if(moi.id!==salon.hote || salon.phase!=="salon") return;
        for(let i=salon.joueurs.length-1;i>=0;i--){
          if(salon.joueurs[i].bot){ salon.joueurs.splice(i,1); break; }
        }
        break;
      }
      case "chat": {
        const texte=String(m.texte||"").trim().slice(0,140);
        if(!texte) return;
        salon.messages.push({nom:moi.nom, id:moi.id, texte, t:Date.now()});
        if(salon.messages.length>40) salon.messages.shift();
        break;
      }
      case "reglage":
        if(moi.id!==salon.hote || salon.phase!=="salon") return;
        salon.cible=objectifValide(m.cible);
        break;
      case "demarrer":
        if(moi.id!==salon.hote || salon.joueurs.length<2) return;
        salon.cible = objectifValide(m.cible);
        salon.manche=0;
        salon.joueurs.forEach(j=>j.total=0);
        nouvelleManche(salon,0);
        break;
      case "piocher":   piocher(salon,moi); break;
      case "fuir":      fuir(salon,moi); break;
      case "fuiteFantome": fuirFantome(salon,moi); break;
      case "continuer": continuer(salon,moi); break;
      case "speciale":  jouerSpeciale(salon,moi,m); break;
      case "ordre":     ordreEspion(salon,moi,m); break;
      case "prendre":   prendreCarte(salon,moi,m); break;
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
    /* Si une nouvelle socket a déjà repris la place, la fermeture de l'ancienne
       ne doit surtout pas déconnecter le joueur à nouveau. */
    if(moi.ws!==socket) return;

    moi.connecte=false;
    moi.ws=null;

    /* Au salon, on garde la place deux minutes : largement assez pour passer
       sur Snap/WhatsApp, copier le code puis revenir. */
    if(salon.phase==="salon"){
      if(moi._retraitTimer) clearTimeout(moi._retraitTimer);
      const s=salon, j=moi;
      moi._retraitTimer=setTimeout(()=>{
        j._retraitTimer=null;
        if(j.connecte || s.phase!=="salon") return;
        s.joueurs=s.joueurs.filter(x=>x!==j);
        if(s.hote===j.id && s.joueurs.length){
          const prochain=s.joueurs.find(x=>!x.bot && x.connecte) || s.joueurs.find(x=>!x.bot) || s.joueurs[0];
          if(prochain) s.hote=prochain.id;
        }
        if(!s.joueurs.some(x=>!x.bot && x.connecte) && !s.joueurs.some(x=>!x.bot)){
          salons.delete(s.code);
        }else{
          diffuser(s);
        }
      },120000);
    }

    /* En pleine manche, on laisse 20 s au joueur pour revenir avant de
       passer son tour. Sa place et son score restent conservés. */
    if(salon.phase==="tour" && joueurCourant(salon)===moi){
      if(moi._tourTimer) clearTimeout(moi._tourTimer);
      const s=salon, j=moi;
      moi._tourTimer=setTimeout(()=>{
        j._tourTimer=null;
        if(j.connecte || s.phase!=="tour" || joueurCourant(s)!==j) return;
        tourSuivant(s);
        diffuser(s);
        planifierBot(s);
      },20000);
    }

    /* Si tout le monde ferme l'application, le salon reste récupérable
       pendant cinq minutes, puis il est nettoyé du serveur. */
    const humainConnecte=salon.joueurs.some(j=>!j.bot && j.connecte);
    if(!humainConnecte){
      if(salon._videTimer) clearTimeout(salon._videTimer);
      const s=salon;
      salon._videTimer=setTimeout(()=>{
        s._videTimer=null;
        if(!s.joueurs.some(j=>!j.bot && j.connecte)) salons.delete(s.code);
      },300000);
    }

    diffuser(salon);
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

module.exports = { nouveauSalon, botAgit, planifierBot, prendreCarte, nouvelleManche, piocher, fuir, fuirFantome, continuer,
                   jouerSpeciale, ordreEspion, finManche, police, etatPublic, valeur, salons };
