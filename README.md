# The Car Chapter · landing page pilote · v1.4

---

## ⛔ BLOCKERS AVANT PUBLICATION

**1. Paiement / Smart.** La page affiche 49 €, « Créer mon Car Chapter » et un délai de 3 jours ouvrés, mais le Tally n'encaisse pas encore. Ne pas publier commercialement avant que le paiement soit actif, ou qu'un mode « pré-ouverture » soit explicitement choisi.

**2. Consentement sur les photos sources.** Le module « Les photos envoyées » publie 4 photos originales du chapitre Australia (`source-car`, `source-journey`, `source-night`, `source-life`). Le consentement de Cecilia couvre l'œuvre finale et une courte description, **pas les photos sources**. Elle apparaît, de loin et non identifiable, sur `source-night` et `source-life`. Obtenir son accord écrit sur ces 4 photos avant publication. Les photos sources de la Škoda ne sont volontairement pas publiées (accord de Yoann limité à l'œuvre).

---

Site statique : HTML, CSS, JavaScript. Aucun framework, aucun déploiement.

## Lancer en local

```
cd site
python3 -m http.server 8000
```

Test Tally : `http://localhost:8000/?utm_source=whatsapp&utm_medium=dm&utm_campaign=pilot&ref=test`, puis vérifier dans Tally que `utm_*`, `ref` et `landing_page` sont remplis.

## À tester sur ta machine (impossible dans mon environnement, Tally y est bloqué)

- **Molette de souris au-dessus du formulaire Tally.** Le défilement doux (Lenis) est actif à la souris ; vérifier que la page continue de défiler quand le curseur passe sur le formulaire.
- **iPhone réel** : premier écran, tirages, formulaire.

## Structure

```
index.html            la page
styles.css            palette + Manrope, système de mouvement
script.js             Tally, défilement doux, glissé vers le formulaire, header, apparitions
assets/fonts/         Manrope auto-hébergée
assets/vendor/        Lenis 1.3.26 (MIT, licence incluse), défilement doux
assets/img/           œuvres publiques, 4 photos sources, logo, image de partage, favicons
```

## Configuration (en haut de `script.js`)

- `CONTACT_EMAIL` : vide = aucun contact affiché.
- `LEGAL_URL` : vide = aucun lien légal affiché.

## Règles assets

- Aucune plaque réelle publiée : copies publiques uniquement, originaux privés jamais substitués.
- Favicon actuel = placeholder dérivé du logo.
