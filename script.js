/* =========================================================
   The Car Chapter · script de la landing page pilote · v1.4
   1. Tally : utm_*, ref et landing_page transmis aux hidden fields.
   2. Défilement doux (Lenis) : souris et trackpad uniquement,
      jamais sur écran tactile, jamais en mouvement réduit.
   3. CTA : un glissé lent jusqu'au formulaire, puis focus.
   4. Header qui s'installe une fois le Hero quitté.
   5. Apparitions uniques au défilement (IntersectionObserver).
   6. Contact et mentions légales rendus seulement s'ils existent.
   Aucun écouteur "scroll" sur window.
   ========================================================= */

const CONFIG = {
  CONTACT_EMAIL: "",   // vide = aucun contact affiché
  LEGAL_URL: "",       // vide = aucun lien légal affiché (structure encore ouverte)
  TRACKED_PARAMS: ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"],
};

const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
let lenis = null;

/* 1. Tally ------------------------------------------------ */
(function initTally() {
  const iframe = document.querySelector("iframe[data-tally-src]");
  if (!iframe) return;
  const params = new URLSearchParams(window.location.search);
  const url = new URL(iframe.dataset.tallySrc);
  CONFIG.TRACKED_PARAMS.forEach((key) => {
    const value = params.get(key);
    if (value) url.searchParams.set(key, value);
  });
  const landing = window.location.protocol === "file:"
    ? window.location.pathname.split("/").pop() || "index.html"
    : window.location.origin + window.location.pathname;
  url.searchParams.set("landing_page", landing);
  iframe.dataset.tallySrc = url.toString();

  const WIDGET = "https://tally.so/widgets/embed.js";
  const load = () => {
    if (typeof window.Tally !== "undefined") window.Tally.loadEmbeds();
    else document.querySelectorAll("iframe[data-tally-src]:not([src])").forEach((el) => { el.src = el.dataset.tallySrc; });
  };
  if (typeof window.Tally !== "undefined") load();
  else if (!document.querySelector(`script[src="${WIDGET}"]`)) {
    const s = document.createElement("script");
    s.src = WIDGET; s.onload = load; s.onerror = load;
    document.body.appendChild(s);
  }
})();

/* 2. Défilement doux --------------------------------------- */
function startLenis() {
  if (lenis || motionQuery.matches || !finePointer.matches || typeof window.Lenis === "undefined") return;
  lenis = new window.Lenis({ lerp: 0.085, wheelMultiplier: 0.9, smoothWheel: true });
  const raf = (time) => { if (!lenis) return; lenis.raf(time); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
}
function stopLenis() { if (lenis) { lenis.destroy(); lenis = null; } }

/* 3. Glissé vers les ancres --------------------------------- */
const easeInOut = (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2);
function initAnchors() {
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    const id = link.getAttribute("href").slice(1);
    const target = id && document.getElementById(id);
    if (!target) return;
    link.addEventListener("click", (event) => {
      const focusTarget = () => { if (target.tabIndex >= 0 || target.hasAttribute("tabindex")) target.focus({ preventScroll: true }); };
      if (lenis) {
        event.preventDefault();
        lenis.scrollTo(target, { duration: 2.1, easing: easeInOut, onComplete: focusTarget });
        history.replaceState(null, "", `#${id}`);
      } else {
        // Défilement natif (CSS smooth, ou instantané en mouvement réduit) ; focus immédiat, sans attente arbitraire.
        focusTarget();
      }
    });
  });
}

/* 4. Header -------------------------------------------------- */
function initHeader() {
  // Un repère invisible à mi-hauteur du premier écran : une fois dépassé, le header s'installe.
  const header = document.querySelector("[data-header]");
  if (!header) return;
  if (!("IntersectionObserver" in window)) { header.classList.add("is-solid"); return; }
  const marker = document.createElement("div");
  marker.setAttribute("aria-hidden", "true");
  marker.style.cssText = "position:absolute;top:55svh;left:0;width:1px;height:1px;pointer-events:none;";
  document.body.prepend(marker);
  new IntersectionObserver(([entry]) => {
    header.classList.toggle("is-solid", !entry.isIntersecting && entry.boundingClientRect.top < 0);
  }).observe(marker);
}

/* 5. Apparitions --------------------------------------------- */
function revealAll() {
  document.querySelectorAll("[data-reveal], .reveal-title, [data-reveal-media], [data-prints]").forEach((el) => el.classList.add("is-visible"));
}
function wrapTitles() {
  // Le titre reste détectable ; seul son contenu se lève derrière un cache.
  document.querySelectorAll(".reveal-title").forEach((title) => {
    if (title.querySelector(":scope > .ri")) return;
    const inner = document.createElement("span");
    inner.className = "ri";
    while (title.firstChild) inner.appendChild(title.firstChild);
    title.appendChild(inner);
  });
}
function initReveal() {
  if (!motionQuery.matches) wrapTitles();
  const items = document.querySelectorAll("[data-reveal], .reveal-title, [data-reveal-media], [data-prints]");
  if (motionQuery.matches || !("IntersectionObserver" in window)) { revealAll(); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      io.unobserve(entry.target);          // une seule apparition : le récit ne se rejoue pas
    });
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.12 });
  items.forEach((el) => io.observe(el));
}

/* 6. Footer ---------------------------------------------------- */
function initFooter() {
  const contact = document.querySelector("[data-contact]");
  if (contact && CONFIG.CONTACT_EMAIL) {
    const a = document.createElement("a");
    a.href = `mailto:${CONFIG.CONTACT_EMAIL}`; a.textContent = CONFIG.CONTACT_EMAIL;
    contact.append("Contact : ", a); contact.hidden = false;
  }
  const legal = document.querySelector("[data-legal]");
  if (legal && CONFIG.LEGAL_URL) {
    const a = document.createElement("a");
    a.href = CONFIG.LEGAL_URL; a.textContent = "Mentions légales";
    legal.append(a); legal.hidden = false;
  }
}

/* Démarrage --------------------------------------------------- */
startLenis();
initAnchors();
initHeader();
initReveal();
initFooter();

// Si la préférence de mouvement change pendant la visite, tout se fige proprement.
motionQuery.addEventListener("change", () => {
  if (motionQuery.matches) { stopLenis(); revealAll(); } else { startLenis(); }
});
finePointer.addEventListener("change", () => { finePointer.matches ? startLenis() : stopLenis(); });
