#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Construit le-braquage-multi.html en y embarquant le moteur de jeu du serveur.
   Les règles ne sont donc écrites qu'à un seul endroit : serveur.js.
   Lancer après chaque modification des règles :  python3 construire.py
"""
import re, sys, pathlib

ici = pathlib.Path(__file__).parent
serveur = (ici/"serveur.js").read_text()
page = (ici/"le-braquage-multi.html").read_text()

# --- on découpe le bloc de règles du serveur ---
deb = serveur.index("/* ---------- règles du jeu")
fin = serveur.index("/* ---------- WebSocket")
regles = serveur[deb:fin]

# quelques adaptations pour tourner dans un navigateur
regles = regles.replace("const NOMS_BOTS=", "var NOMS_BOTS_MOTEUR=")
# la carte des salons et les constantes du serveur sont déjà fournies par l'enveloppe
regles = regles.replace("const salons = new Map();", "")

moteur = """/* ===========================================================
   MOTEUR LOCAL — le même code de règles que le serveur, embarqué
   ici pour que la partie solo tourne sans serveur ni connexion.
   Généré par construire.py : ne pas modifier à la main.
   =========================================================== */
var MOTEUR=(function(){
  var crypto={ randomInt:function(n){ return Math.floor(Math.random()*n); } };
  var salons=new Map();                // une seule table : la partie en cours
  function envoyer(){}                 // pas de réseau ici

__REGLES__

  var S=null, MOI="moi", RENDU=null;
  diffuser=function(s){ if(RENDU) RENDU(etatPublic(s,MOI)); };

  function demarrer(nom,combien,cible,rendu){
    RENDU=rendu;
    S=nouveauSalon(MOI);
    S.solo=true;
    S.cible=(cible===50?50:100);
    S.joueurs.push({id:MOI, nom:(nom||"Toi").slice(0,10), ws:null, connecte:true,
      total:0, sac:[], main:[], planque:[], fui:false, pris:false, force:false, rab:0});
    var n=Math.max(1,Math.min(9,combien|0||2));
    for(var i=0;i<n;i++){
      S.joueurs.push({id:"bot-"+i, nom:NOMS_BOTS_MOTEUR[i], bot:true, ws:null, connecte:true,
        total:0, sac:[], main:[], planque:[], fui:false, pris:false, force:false, rab:0});
    }
    salons.set(S.code,S);
    S.manche=0;
    nouvelleManche(S,0);
    diffuser(S);
    planifierBot(S);
    return MOI;
  }

  function action(m){
    if(!S) return;
    var moi=S.joueurs[0];
    switch(m.t){
      case "piocher":   piocher(S,moi); break;
      case "fuir":      fuir(S,moi); break;
      case "continuer": continuer(S,moi); break;
      case "speciale":  jouerSpeciale(S,moi,m); break;
      case "ordre":     ordreEspion(S,moi,m); break;
      case "mancheSuivante":
        if(S.phase==="police"){ finManche(S); break; }
        if(S.phase!=="finManche") return;
        nouvelleManche(S, S.premierFuyard===null ? S.tour+1 : S.premierFuyard);
        break;
      case "rejouer":
        S.joueurs.forEach(function(j){ j.total=0; });
        S.manche=0;
        nouvelleManche(S,0);
        break;
      default: return;
    }
    diffuser(S);
    planifierBot(S);
  }

  function arreter(){ if(S){ salons.delete(S.code); S=null; RENDU=null; } }

  return { demarrer:demarrer, action:action, arreter:arreter, MOI:MOI,
           NOMS:NOMS_BOTS_MOTEUR };
})();
""".replace("__REGLES__", regles)

# --- on l'insère juste avant la liaison serveur ---
ancre = "/* ================= LIAISON AVEC LE SERVEUR ================= */"
if "MOTEUR LOCAL" in page:                      # remplacement d'une version précédente
    d = page.index("/* ===========================================================\n   MOTEUR LOCAL")
    f = page.index(ancre)
    page = page[:d] + moteur + "\n" + page[f:]
else:
    page = page.replace(ancre, moteur + "\n" + ancre)

(ici/"le-braquage-multi.html").write_text(page)
print("moteur local embarqué :", len(moteur)//1024, "Ko")
