// Shared furniture for every page under /internal: the theme toggle and, on the
// plan pages, the sticky contents index. Each plan is its own document at its
// own URL now, so there is no document switcher here — a page declares its own
// sections and this file only renders and tracks them.

// ---- theme toggle. The stylesheet already follows prefers-color-scheme; the
// button only writes an explicit override, so an untouched visit keeps tracking
// the OS setting.
const themebtn = document.getElementById("themebtn");
const savedTheme = localStorage.getItem("navsafe-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
if (themebtn) themebtn.addEventListener("click", e => {
  e.stopPropagation();
  const dark = getComputedStyle(document.documentElement)
    .getPropertyValue("color-scheme").trim() === "dark";
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("navsafe-theme", next);
});

// ---- contents index. `items` is a list of [class, href, label]; class is
// "part" for a part heading, "tocleaf" for a nested leaf, "" for a section.
function initToc(items) {
  const tocnav = document.getElementById("tocnav");
  if (!tocnav) return;

  tocnav.innerHTML = items.length
    ? items.map(([cls, href, label]) => `<a class="${cls}" href="${href}">${label}</a>`).join("")
    : `<p class="tocempty">No sections yet</p>`;

  const tocLinks = [...tocnav.querySelectorAll("a")];
  const spy = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) {
      const id = "#" + e.target.id;
      tocLinks.forEach(a => a.classList.toggle("active", a.getAttribute("href") === id));
    }
  }, { rootMargin: "-60px 0px -72% 0px", threshold: 0 });
  for (const a of tocLinks) {
    const sec = document.querySelector(a.getAttribute("href"));
    if (sec) spy.observe(sec);
  }
}
