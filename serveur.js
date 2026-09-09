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
const SPECIALES = ["balance","complice","sacperce","espion","vol"];
const NOMS_SP = {
  balance:"BALANCE", complice:"COMPLICE", sacperce:"SAC PERCÉ",
  espion:"L'ESPION", vol:"LE VOL"
};

function melange(a){
  for(let i=a.length-1;i>0;i--){ const j=crypto.randomInt(i+1); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function neufPaquet(){
  const d=[];
  for(const v in QTES) for(let i=0;i<QTES[v];i++) d.push({t:"butin",v:+v});
  for(let i=0;i<9;i++) d.push({t:"alarme"});
  for(const k of SPECIALES) for(let i=0;i<3;i++) d.push({t:"sp",k});
  return melange(d);
}
const valeur = j => j.sac.reduce((s,c)=>s+c.v,0);

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
    code:s.code, phase:s.phase, cible:s.cible, manche:s.manche,
    alarmes:s.alarmes, restantes:s.pioche.length, hote:s.hote,
    tour:s.tour, evenement:filtrerEvenement(s.evenement,pourId),
    apercu:null, classement:s.classement,
    joueurs:s.joueurs.map(j=>({
      id:j.id, nom:j.nom, connecte:j.connecte, total:j.total,
      sac:j.sac,                                   // le butin reste posé sur la table
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
  s.manche++; s.pioche=neufPaquet(); s.alarmes=0; s.premierFuyard=null;
  s.evenement=null; s.apercu=null; s.classement=null;
  s.joueurs.forEach(j=>{ j.sac=[]; j.main=[]; j.fui=false; j.pris=false; j.force=false; });
  s.tour = premier % s.joueurs.length;
  if(!s.joueurs[s.tour].connecte) tourSuivant(s);
  s.phase="tour";
}

function finManche(s){
  s.joueurs.forEach(j=>{ if(!j.pris) j.total += valeur(j); });
  s.classement = s.joueurs.slice().sort((a,b)=>b.total-a.total)
    .map(j=>({id:j.id, nom:j.nom, total:j.total, gagne:j.pris?0:valeur(j)}));
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
    else { j.pris=true; j.sac=[]; pris.push(j.nom); }
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
           total:0, sac:[], main:[], fui:false, pris:false, force:false};
      salon.joueurs.push(moi);
      salons.set(salon.code,salon);
      repondre({t:"moi", id, code:salon.code});
      return diffuser(salon);
    }

    if(m.t==="rejoindre"){
      const s=salons.get((m.code||"").toUpperCase().trim());
      if(!s) return repondre({t:"erreur", msg:"Aucune partie avec ce code."});
      if(s.phase!=="salon") return repondre({t:"erreur", msg:"Cette partie a déjà commencé."});
      if(s.joueurs.length>=8) return repondre({t:"erreur", msg:"La table est complète (8 joueurs)."});
      const id=crypto.randomUUID();
      salon=s;
      moi={id, nom:(m.nom||"Joueur").slice(0,10), ws:socket, connecte:true,
           total:0, sac:[], main:[], fui:false, pris:false, force:false};
      salon.joueurs.push(moi);
      repondre({t:"moi", id, code:salon.code});
      return diffuser(salon);
    }

    if(!salon || !moi) return;

    switch(m.t){
      case "demarrer":
        if(moi.id!==salon.hote || salon.joueurs.length<2) return;
        salon.cible = (m.cible===50?50:100);
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

module.exports = { nouveauSalon, nouvelleManche, piocher, fuir, continuer,
                   jouerSpeciale, ordreEspion, finManche, police, etatPublic, valeur, salons };
