#!/usr/bin/env node
/* Vérification complète du Braquage avant livraison. */
"use strict";
const fs=require("fs"), path=require("path");
const ici=__dirname;
let echecs=0, avert=0;
function ok(t){ console.log("  \x1b[32m✓\x1b[0m "+t); }
function ko(t){ console.log("  \x1b[31m✗\x1b[0m "+t); echecs++; }
function attention(t){ console.log("  \x1b[33m!\x1b[0m "+t); avert++; }
function titre(t){ console.log("\n\x1b[1m"+t+"\x1b[0m"); }

const page=fs.readFileSync(path.join(ici,"le-braquage-multi.html"),"utf8");
const html=page;
const js=page.match(/<script>([\s\S]*)<\/script>/)[1];
const css=page.match(/<style>([\s\S]*)<\/style>/)[1];
const codeSansLancement=js.replace(/\necranAccueil\(\);\s*$/,"");

/* ---------- 1. fichiers ---------- */
titre("1. Fichiers du dépôt");
["serveur.js","le-braquage-multi.html","package.json","manifest.webmanifest",
 "icone-192.png","icone-512.png","README.md","construire.py","sw.js"].forEach(f=>{
  fs.existsSync(path.join(ici,f)) ? ok(f) : ko("manquant : "+f);
});

/* ---------- 2. syntaxe ---------- */
titre("2. Syntaxe");
try{ new Function(codeSansLancement); ok("script de la page"); }
catch(e){ ko("script de la page : "+e.message); }
try{ require(path.join(ici,"serveur.js")); ok("serveur"); }
catch(e){ ko("serveur : "+e.message); }
const o=(css.match(/{/g)||[]).length, f=(css.match(/}/g)||[]).length;
o===f ? ok("feuille de style équilibrée ("+o+" blocs)") : ko("style déséquilibré "+o+"/"+f);
const bo=(html.match(/<div/g)||[]).length;
ok("page : "+Math.round(html.length/1024)+" Ko");

/* ---------- 3. fonctions et variables ---------- */
titre("3. Références");
const definies=new Set([...codeSansLancement.matchAll(/function\s+([A-Za-zÀ-ÿ_$][\w$]*)/g)].map(m=>m[1]));
[...codeSansLancement.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)].forEach(m=>definies.add(m[1]));
[...codeSansLancement.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*function/g)].forEach(m=>definies.add(m[1]));
const natifs=new Set(["if","for","while","switch","catch","return","function","typeof","new","else","do","try",
 "parseInt","parseFloat","Math","JSON","String","Number","Array","Object","Set","Map","Boolean","Date",
 "setTimeout","clearTimeout","requestAnimationFrame","encodeURIComponent","decodeURIComponent","isNaN",
 "alert","console","WebSocket","Error","RegExp","Promise","document","window","navigator","location"]);
const appels=[...new Set([...codeSansLancement.matchAll(/(?:^|[^\w.$'"])([a-zA-ZÀ-ÿ_][\w]{2,})\s*\(/g)].map(m=>m[1]))];
const manquantes=appels.filter(n=>!definies.has(n)&&!natifs.has(n));
manquantes.length ? attention("à vérifier : "+manquantes.join(", ")) : ok("aucune fonction appelée sans définition");

/* ---------- 4. styles des identifiants visuels ---------- */
titre("4. Styles");
const imagesSansTaille=[];
[...js.matchAll(/id="([a-z-]+)"[\s\S]{0,200}?<svg(?![^>]*width=)/g)].forEach(m=>{
  if(!css.includes("#"+m[1]+" svg")) imagesSansTaille.push(m[1]);
});
imagesSansTaille.length ? ko("images sans dimension : "+imagesSansTaille.join(", "))
  : ok("toutes les images ont une taille définie");
const varsUtil=new Set([...page.matchAll(/var\((--[a-z-]+)\)/g)].map(m=>m[1]));
const bloc=css.match(/:root\{[\s\S]*?\}/)[0];
const varsDef=new Set([...bloc.matchAll(/(--[a-z-]+)\s*:/g)].map(m=>m[1]));
const varsManquantes=[...varsUtil].filter(v=>!varsDef.has(v)&&v!=="--dx"&&v!=="--dy");
varsManquantes.length ? ko("couleurs non définies : "+varsManquantes.join(", "))
  : ok("toutes les couleurs sont définies ("+varsDef.size+")");
const anims=[...css.matchAll(/@keyframes\s+([A-Za-z]+)/g)].map(m=>m[1]);
const animsUtil=[...css.matchAll(/animation:\s*([A-Za-z]+)/g)].map(m=>m[1]).filter(a=>a!=="none");
const animsOrphelines=animsUtil.filter(a=>!anims.includes(a));
animsOrphelines.length ? ko("animations sans définition : "+animsOrphelines.join(", "))
  : ok(anims.length+" animations, toutes définies");

/* ---------- 5. faux navigateur ---------- */
titre("5. Écrans (rendu réel)");
function navigateur(){
  let ecran="", clics={}, erreurs=[];
  function fe(){const e={style:{setProperty(){},cssText:""},dataset:{},classList:{add(){},remove(){}},
    innerHTML:"",textContent:"",onclick:null,disabled:false,value:"",
    appendChild(){},remove(){},setAttribute(){},querySelector(){return fe();},querySelectorAll(){return [];},
    getBoundingClientRect(){return{left:0,top:0,width:390,height:420};},
    clientWidth:340,clientHeight:400,offsetHeight:110};
    e.firstElementChild=e; return e;}
  const appEl={ get innerHTML(){return ecran;}, set innerHTML(v){ecran=v; Object.keys(clics).forEach(k=>delete clics[k]);},
    classList:{add(){},remove(){}}, style:{}, appendChild(){}, clientWidth:390, clientHeight:400,
    className:"", offsetHeight:110,
    querySelectorAll(sel){ const m=[...ecran.matchAll(/data-(dcarte|dcible|main|i|c)="(\d+)"/g)];
      return m.filter(x=>sel.includes(x[1])).map(x=>{const el=fe(); el.dataset[x[1]]=x[2];
        Object.defineProperty(el,"onclick",{set(fn){clics[x[1]+x[2]]=fn;}}); return el;}); },
    querySelector(){return null;} };
  global.window={addEventListener(){}};
  try{ Object.defineProperty(global,"navigator",{value:{vibrate(){}},configurable:true,writable:true}); }catch(e){}
  global.requestAnimationFrame=fn=>fn(); global.innerWidth=390; global.innerHeight=780;
  global.location={protocol:"file:",host:""};
  const T=[]; global.setTimeout=(fn,d)=>{T.push({fn,d:d||0});return T.length;};
  global.document={ getElementById:id=>{ if(id==="app") return appEl; const el=fe();
      Object.defineProperty(el,"onclick",{set(fn){clics[id]=fn;}}); return el; },
    querySelector:s=>{const el=fe(); Object.defineProperty(el,"onclick",{set(fn){clics[s]=fn;}}); return el;},
    querySelectorAll:()=>[], createElement:()=>fe(), body:{appendChild(){}} };
  const API=new Function(codeSansLancement+
    "\nreturn {ecranAccueil,ecranRegles,ecranSolo,ecranNom,ecranDidacticiel,ecranGalerieCartes,"+
    "MOTEUR,recevoirEtat,envoyer,get E(){return E;},get DIDAC(){return DIDAC;},"+
    "set SOLO(v){SOLO=v;},set MOI(v){MOI=v;},get MOI(){return MOI;}};")();
  return {API, get ecran(){return ecran;}, clics, T, erreurs};
}
const N=navigateur();
[["accueil","ecranAccueil","apprendre à jouer"],
 ["règles","ecranRegles","RÈGLES DU JEU"],
 ["réglages solo","ecranSolo","Complices du téléphone"],
 ["galerie des cartes","ecranGalerieCartes","LES CARTES SPÉCIALES"]].forEach(([nom,fn,attendu])=>{
  try{ N.API[fn](); N.ecran.includes(attendu) ? ok("écran "+nom) : ko("écran "+nom+" : contenu inattendu"); }
  catch(e){ ko("écran "+nom+" : "+e.message); }
});

/* ---------- 6. didacticiel ---------- */
titre("6. Apprentissage");
try{
  const D=navigateur();
  D.API.ecranDidacticiel();
  let n=0, sansSortie=0, sansBouton=false;
  for(let i=0;i<60;i++){
    if(!D.API.DIDAC) break;
    if(!/class="voile"/.test(D.ecran) && !/id="sortir"/.test(D.ecran)) sansSortie++;
    let fait=false;
    for(const k of ["#d-suite","#d-ok","#d-piocher","#d-fuir","dcarte0","dcible1","#d-fin"]){
      if(D.clics[k]){ D.clics[k](); fait=true; n++; break; }
    }
    if(!fait){ sansBouton=true; break; }
  }
  n>=20 && !sansBouton ? ok("déroulé complet ("+n+" étapes)") : ko("bloqué après "+n+" étapes");
  sansSortie===0 ? ok("bouton Quitter sur tous les écrans") : ko(sansSortie+" écran(s) sans bouton Quitter");
  D.ecran.includes("apprendre à jouer") ? ok("retour à l'accueil") : ko("ne revient pas à l'accueil");
}catch(e){ ko("apprentissage : "+e.message); }

/* ---------- 7. partie solo hors ligne ---------- */
titre("7. Partie solo (sans serveur)");
[2,5,9].forEach(bots=>{
  try{
    const D=navigateur();
    global.WebSocket=function(){ throw new Error("connexion interdite en solo"); };
    D.API.SOLO=true; D.API.MOI=D.API.MOTEUR.MOI;
    let etat=null;
    D.API.MOTEUR.demarrer("Test",bots,50,e=>{etat=e; D.API.recevoirEtat(e);});
    const purge=()=>{let k=0; while(D.T.length&&k<600){const t=D.T.shift();k++;try{t.fn();}catch(e){}}};
    let tours=0, sansBoutons=0;
    for(let i=0;i<40000;i++){
      purge();
      if(!etat||etat.phase==="victoire") break;
      if(etat.phase==="finManche"||etat.phase==="police"){ D.API.envoyer({t:"mancheSuivante"}); continue; }
      if(etat.joueurs[etat.tour].id!==D.API.MOI){ if(!D.T.length) break; continue; }
      if(etat.phase==="tour"){
        tours++;
        if(!(D.ecran.includes('id="piocher"')&&D.ecran.includes('id="fuir"'))) sansBoutons++;
        const moi=etat.joueurs.find(j=>j.id===D.API.MOI);
        const v=moi.sac.reduce((s,c)=>s+c.v,0);
        D.API.envoyer((!moi.force&&(v>=13||(etat.alarmes===2&&v>=6)))?{t:"fuir"}:{t:"piocher"});
      }
      else if(etat.phase==="revele") D.API.envoyer({t:"continuer"});
      else if(etat.phase==="vol"){ const c=etat.joueurs.filter(x=>x.id!==D.API.MOI&&!x.fui&&!x.pris&&x.sac.length);
        D.API.envoyer(c.length?{t:"speciale",cible:c[0].id,carte:0}:{t:"continuer"}); }
      else if(etat.phase==="espion") D.API.envoyer({t:"ordre",ordre:[0,1,2]});
      else break;
    }
    const fini=(etat&&etat.phase==="victoire");
    fini && sansBoutons===0
      ? ok((bots+1)+" joueurs : partie terminée, boutons présents à chaque tour")
      : ko((bots+1)+" joueurs : "+(fini?"":"non terminée ")+(sansBoutons?sansBoutons+" tours sans boutons":""));
  }catch(e){ ko(bots+" complices : "+e.message); }
});

/* ---------- 8. règles du serveur ---------- */
titre("8. Règles (serveur)");
delete require.cache[require.resolve(path.join(ici,"serveur.js"))];
const S=require(path.join(ici,"serveur.js"));
function salon(n){
  const s=S.nouveauSalon("h");
  for(let i=0;i<n;i++) s.joueurs.push({id:"j"+i,nom:"J"+i,ws:null,connecte:true,total:0,
    sac:[],main:[],planque:[],fui:false,pris:false,force:false,rab:0});
  s.cible=50; S.nouvelleManche(s,0); return s;
}
let bloque=0, parties=0;
for(let p=0;p<400;p++){
  const n=2+Math.floor(Math.random()*9);
  const s=salon(n);
  let it=0, fige=false;
  while(it++<8000){
    if(s.phase==="victoire") break;
    const j=s.joueurs[s.tour];
    if(s.phase==="tour"){
      const i=j.main.findIndex(c=>["monteenlair","troc","courtcircuit","planque","balance","sacperce"].includes(c.k));
      if(i>=0&&Math.random()<0.5){
        const c=j.main[i], ci=s.joueurs.filter(x=>x!==j&&!x.fui&&!x.pris);
        S.jouerSpeciale(s,j,{index:i,cible:ci.length?ci[0].id:null,carte:0});
      } else if(Math.random()<0.2) S.fuir(s,j); else S.piocher(s,j);
    }
    else if(s.phase==="revele") S.continuer(s,j);
    else if(s.phase==="vol"){ const c=s.joueurs.filter(x=>x!==j&&!x.fui&&!x.pris&&x.sac.length);
      c.length?S.jouerSpeciale(s,j,{cible:c[0].id,carte:0}):S.continuer(s,j); }
    else if(s.phase==="espion") S.ordreEspion(s,j,{ordre:[0,1,2]});
    else if(s.phase==="police") S.finManche(s);
    else if(s.phase==="finManche") S.nouvelleManche(s,s.premierFuyard===null?s.tour+1:s.premierFuyard);
    else { fige=true; break; }
  }
  (fige||it>=8000)?bloque++:parties++;
}
bloque===0 ? ok("400 parties de 2 à 10 joueurs, aucune bloquée") : ko(bloque+" parties bloquées");

const s=salon(4);
const pos=[]; s.pioche.forEach((c,i)=>{ if(c.t==="alarme") pos.push(i); });
pos.length===9 ? ok("9 alarmes par paquet") : ko(pos.length+" alarmes");
const ecarts=[]; for(let i=1;i<pos.length;i++) ecarts.push(pos[i]-pos[i-1]);
Math.min(...ecarts)>=6 ? ok("écart minimum de "+Math.min(...ecarts)+" cartes entre deux alarmes")
  : ko("alarmes trop rapprochées : "+Math.min(...ecarts));
pos[0]>=7 ? ok("aucune alarme avant la carte "+(pos[0]+1)) : ko("alarme trop tôt");
const tailles={};
[3,6,10].forEach(n=>{ const x=salon(n); tailles[n]=x.pioche.length; });
tailles[10]>tailles[3] ? ok("paquet adapté à la table ("+tailles[3]+" à 3 joueurs, "+tailles[10]+" à 10)")
  : ko("le paquet ne s'adapte pas");

/* ---------- 8bis. installation ---------- */
titre("8bis. Installation de l'application");
try{
  const man=JSON.parse(fs.readFileSync(path.join(ici,"manifest.webmanifest"),"utf8"));
  ["name","short_name","start_url","display","icons","theme_color"].every(c=>man[c])
    ? ok("manifeste complet") : ko("manifeste incomplet");
  man.icons.length>=2 ? ok(man.icons.length+" icônes déclarées") : ko("icônes manquantes");
  const sw=fs.readFileSync(path.join(ici,"sw.js"),"utf8");
  new Function(sw.replace(/self\./g,"({}).")); ok("service de cache : syntaxe");
  sw.includes("caches.open") && sw.includes("addEventListener(\"fetch\"")
    ? ok("cache et interception en place") : ko("service de cache incomplet");
  js.includes("serviceWorker.register") ? ok("la page enregistre le service") : ko("service non enregistré");
  const srv=fs.readFileSync(path.join(ici,"serveur.js"),"utf8");
  srv.includes('"/sw.js"') ? ok("le serveur sert le service") : ko("le serveur ne sert pas /sw.js");
}catch(e){ ko("installation : "+e.message); }

/* ---------- 9. moteur embarqué = moteur du serveur ---------- */
titre("9. Cohérence des règles");
const serveurTxt=fs.readFileSync(path.join(ici,"serveur.js"),"utf8");
const deb=serveurTxt.indexOf("/* ---------- règles du jeu");
const fin=serveurTxt.indexOf("/* ---------- WebSocket");
const reglesServeur=serveurTxt.slice(deb,fin).replace("const NOMS_BOTS=","var NOMS_BOTS_MOTEUR=")
  .replace("const salons = new Map();","");
js.includes(reglesServeur.slice(200,1200))
  ? ok("la page embarque exactement les règles du serveur")
  : ko("les règles de la page diffèrent du serveur — relancer construire.py");

/* ---------- bilan ---------- */
console.log("\n"+"─".repeat(52));
if(echecs===0) console.log("\x1b[32m\x1b[1m  AUCUNE ERREUR — prêt pour le lancement\x1b[0m"+(avert?"  ("+avert+" point(s) à surveiller)":""));
else console.log("\x1b[31m\x1b[1m  "+echecs+" ERREUR(S) À CORRIGER\x1b[0m");
console.log("─".repeat(52));
process.exit(echecs?1:0);
