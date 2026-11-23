// ═══════════════════════════════════════════════════════════════
//  SWITCHREADER — parallel-text lesson reader
// ═══════════════════════════════════════════════════════════════

const APP_BUILD = "2026-11-23a";   // shown at the bottom of Settings: tells you which build is running
let offlineStatusEl = null;        // the small "Offline ready" line under it

// Some browsers have no text-to-speech at all. Remember that, and give the
// rest of the code a harmless stand-in so the app still loads and reads.
const speechSupported = "speechSynthesis" in window &&
                        typeof SpeechSynthesisUtterance !== "undefined";
if (!("speechSynthesis" in window)) {
    window.speechSynthesis = {
        speaking: false,
        pending: false,
        speak() {},
        cancel() {},
        getVoices() { return []; },
        addEventListener() {}
    };
}

const languageNames = {
    "en-GB": "English",
    "en-US": "English (US)",
    "es-ES": "Spanish",
    "it-IT": "Italian",
    "ru-RU": "Russian",
    "ja-JP": "Japanese",
    "fr-FR": "French",
    "pt-PT": "Portuguese (European)",
    "pt-BR": "Portuguese (Brazilian)"
};

// ═══════════════════════════════════════════════════════════════
//  LIBRARY STATE
// ═══════════════════════════════════════════════════════════════

let library = [];              // array of lesson objects
let currentLessonId = null;    // string or null
let currentBook = null;        // { l2Code, l2Name, l1Code, l1Name } while a lesson is open

let readingUnits = [];         // raw units of the currently open lesson
let pages = [];                // paginated pages of the currently open lesson
let displayMode = 2;
let currentPage = 0;
let lastPaginatedWidth = 0;    // text-box size the pages were last built for
let lastPaginatedHeight = 0;
let lastPageKey = "";           // which page (at which size) was drawn last
let lastRenderMode = -1;        // which language/blank mode was drawn last
let heldReadingPoint = null;    // "where you were" in the language you just left
let scrollByMode = {};          // used when "follow my place" is off: each language's own scroll
let lastRenderSentence = -1;
let pendingScrollTarget = null; // where a smooth scroll is heading, if one is in progress
let pendingScrollTimer = null;

function loadLibrary() {
    const raw = localStorage.getItem("switchreader-library");
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error("Library parse error, discarding:", e);
        return [];
    }
}

function saveLibrary() {
    try {
        localStorage.setItem("switchreader-library", JSON.stringify(library));
        return true;
    } catch (e) {
        console.error("Could not save library:", e);
        return false;
    }
}

function seedLibraryIfEmpty() {
    if (localStorage.getItem("switchreader-librarySeeded") === "true") return;
    localStorage.setItem("switchreader-librarySeeded", "true");
    if (library.length > 0) return;

    library.push({
        id: "les_sample",
        title: "The Dark Room",
        l2Code: "es-ES",
        l2Name: "Spanish",
        l1Code: "en-GB",
        l1Name: "English",
        units: [
            { l2: ["La puerta estaba abierta.", "Entró lentamente en la habitación."],
              l1: ["The door was open.", "He slowly entered the room."] },
            { l2: ["La habitación estaba completamente a oscuras.", "No podía ver nada."],
              l1: ["The room was completely dark.", "He couldn't see anything."] },
            { l2: ["De repente, oyó un ruido detrás de él.", "Se volvió rápidamente."],
              l1: ["Suddenly, he heard a noise behind him.", "He turned around quickly."] },
            { l2: ["No había nadie allí.", "Pero la puerta se había cerrado."],
              l1: ["There was nobody there.", "But the door had closed."] }
        ],
        position: { page: 0, sentence: 0, mode: 2 },
        createdAt: Date.now()
    });
    saveLibrary();
}

// Your place is stored as "sentence number N of the lesson" (counting
// L2 sentences from the very start), not as a page number. Page numbers
// change when the font size or screen shape changes; sentence numbers don't.
// It lives in its own tiny entry so saving it never rewrites the whole library.
function positionKey(lessonId) {
    return "switchreader-pos-" + lessonId;
}

// The last page of every lesson is an "end card" (buttons for what to do
// next). It holds no sentences. These helpers tell it apart from real pages.
function makeEndPage(totalSentences) {
    return { l2: [], l1: [], l3: [], isEnd: true,
             startUnitIndex: readingUnits.length, endUnitIndex: readingUnits.length,
             startSentence: totalSentences };
}

function realPageCount() {
    return pages.length > 0 && pages[pages.length - 1].isEnd ? pages.length - 1 : pages.length;
}

// The lesson-wide number of the sentence you are on right now.
function currentGlobalSentence() {
    const page = pages[currentPage];
    if (!page || typeof page.startSentence !== "number") return 0;
    if (page.isEnd) return Math.max(0, page.startSentence - 1);   // on the end card: the last sentence
    const within = Math.max(0, Math.min(currentSentenceIndex, page.l2.length - 1));
    return page.startSentence + within;
}

// Turn a lesson-wide sentence number back into a page and a sentence on it,
// using the pages as they are laid out right now.
function locateGlobalSentence(globalSentence) {
    const realPages = realPageCount();
    if (realPages === 0) return { page: 0, sentence: 0 };
    let pageIndex = 0;
    for (let i = 0; i < realPages; i++) {
        if (pages[i].startSentence <= globalSentence) pageIndex = i;
        else break;
    }
    const page = pages[pageIndex];
    const within = Math.max(0, Math.min(globalSentence - page.startSentence,
                                        page.l2.length - 1));
    return { page: pageIndex, sentence: within };
}

function loadSavedPosition(lesson) {
    try {
        const raw = localStorage.getItem(positionKey(lesson.id));
        if (raw) {
            const saved = JSON.parse(raw);
            if (saved && typeof saved.sentence === "number") {
                return {
                    sentence: Math.max(0, Math.floor(saved.sentence)),
                    mode: [0, 1, 2].includes(saved.mode) ? saved.mode : 2
                };
            }
        }
    } catch (e) {
        console.error("Could not read saved position:", e);
    }

    // Older versions saved a page number inside the lesson. Use it once.
    const old = lesson.position;
    if (old && realPageCount() > 0) {
        const pageIndex = Math.max(0, Math.min(old.page || 0, realPageCount() - 1));
        const page = pages[pageIndex];
        const within = Math.max(0, Math.min(old.sentence || 0, page.l2.length - 1));
        return {
            sentence: page.startSentence + within,
            mode: [0, 1, 2].includes(old.mode) ? old.mode : 2
        };
    }

    return { sentence: 0, mode: 2 };
}

function saveCurrentPosition() {
    if (!currentLessonId || pages.length === 0) return;
    try {
        const existing = readLessonPosition(currentLessonId);
        localStorage.setItem(positionKey(currentLessonId), JSON.stringify({
            v: 2,
            sentence: currentGlobalSentence(),
            mode: displayMode,
            at: Date.now(),                                    // when you last read it
            finished: !!(existing && existing.finished) || !!pages[currentPage]?.isEnd
        }));
    } catch (e) {
        console.error("Could not save position:", e);
    }
}

let savePositionTimeout = null;
function saveCurrentPositionSoon() {
    if (savePositionTimeout) clearTimeout(savePositionTimeout);
    savePositionTimeout = setTimeout(saveCurrentPosition, 800);
}

// ═══════════════════════════════════════════════════════════════
//  DOM REFERENCES
// ═══════════════════════════════════════════════════════════════

const homeScreen = document.getElementById("home-screen");
const readerScreen = document.getElementById("reader-screen");
const libraryList = document.getElementById("library-list");
const addLessonButton = document.getElementById("add-lesson-button");

const homeSettingsToggle = document.getElementById("home-settings-toggle");
const homeButton = document.getElementById("home-button");
const settingsToggle = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");

const importPanel = document.getElementById("import-panel");
const importClose = document.getElementById("import-close");
const importTitleInput = document.getElementById("import-title");
const importFileInput = document.getElementById("excel-file");
// The real file input is hidden, so let Enter/Space on the "Choose file" label open it.
document.querySelector(".file-picker-label").addEventListener("keydown", function(event) {
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        importFileInput.click();
    }
});
const importConfirmButton = document.getElementById("import-confirm-button");
const fileNameDisplay = document.getElementById("file-name-display");
const l2LanguageSelect = document.getElementById("l2-language");
const l1LanguageSelect = document.getElementById("l1-language");

const readingAreaSection = document.querySelector(".reading-area");
const readingArea = document.getElementById("reading-text");
const modeLabel = document.getElementById("mode-label");
const pageNumber = document.getElementById("page-number");
const scrollUpButton = document.getElementById("scroll-up");
const scrollDownButton = document.getElementById("scroll-down");
const gotoPanel = document.getElementById("goto-panel");
const languagesPanel = document.getElementById("languages-panel");
const languagesList = document.getElementById("languages-list");
const addLessonLabel = document.getElementById("add-lesson-label");
const lessonMenuPanel = document.getElementById("lesson-menu-panel");
const lessonNameInput = document.getElementById("lesson-name-input");

const ttsButton = document.getElementById("tts-toggle");
const ttsIcon = document.getElementById("tts-toggle-icon");
const ttsSpeedSlider = document.getElementById("tts-speed");
const ttsSpeedValue = document.getElementById("tts-speed-value");
const ttsVoiceSelect = document.getElementById("tts-voice");
const ttsHighlightCheckbox = document.getElementById("tts-highlight");

// ═══════════════════════════════════════════════════════════════
//  SETTINGS — persistence
// ═══════════════════════════════════════════════════════════════

const fontSizeSlider = document.getElementById("font-size");
const fontSizeValue = document.getElementById("font-size-value");
const lineSpacingSlider = document.getElementById("line-spacing");
const lineSpacingValue = document.getElementById("line-spacing-value");

// Re-flow the pages after a short pause, so dragging a slider doesn't
// rebuild every page on every tiny movement.
let relayoutTimer = null;
function relayoutSoon() {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(function() {
        if (readerScreen.hidden) return;
        paginateReadingUnits();
        displayPage();
    }, 150);
}

// Font size
const savedFontSize = localStorage.getItem("switchreader-font-size");
if (savedFontSize !== null) fontSizeSlider.value = savedFontSize;

fontSizeSlider.addEventListener("input", function() {
    const size = fontSizeSlider.value;
    readingArea.style.fontSize = size + "px";
    fontSizeValue.textContent = size + "px";
    localStorage.setItem("switchreader-font-size", size);
    
    if (!readerScreen.hidden) relayoutSoon();
});

// Initialize the style immediately on load
fontSizeSlider.dispatchEvent(new Event("input"));

// Line spacing
const savedLineSpacing = localStorage.getItem("switchreader-line-spacing");
if (savedLineSpacing !== null) lineSpacingSlider.value = savedLineSpacing;

lineSpacingSlider.addEventListener("input", function() {
    const spacing = lineSpacingSlider.value / 100;
    readingArea.style.lineHeight = spacing;
    lineSpacingValue.textContent = spacing.toFixed(2);
    localStorage.setItem("switchreader-line-spacing", lineSpacingSlider.value);

    if (!readerScreen.hidden) relayoutSoon();
});

// Initialize the style immediately on load
lineSpacingSlider.dispatchEvent(new Event("input"));

// Highlight
let ttsHighlightEnabled = localStorage.getItem("ttsHighlightEnabled") !== "false";
ttsHighlightCheckbox.checked = ttsHighlightEnabled;
ttsHighlightCheckbox.addEventListener("change", function() {
    ttsHighlightEnabled = ttsHighlightCheckbox.checked;
    localStorage.setItem("ttsHighlightEnabled", ttsHighlightEnabled);
    if (!readerScreen.hidden) displayPage();
});

// Third mode (the optional third spreadsheet column: romanised text, notes).
// An existing choice saved under its old name, "blankModeEnabled", carries over.
const thirdModeCheckbox = document.getElementById("third-mode-enabled");
let thirdModeEnabled = (localStorage.getItem("thirdModeEnabled") ??
                        localStorage.getItem("blankModeEnabled")) !== "false";
thirdModeCheckbox.checked = thirdModeEnabled;
thirdModeCheckbox.addEventListener("change", function() {
    thirdModeEnabled = thirdModeCheckbox.checked;
    localStorage.setItem("thirdModeEnabled", thirdModeEnabled);
    if (!thirdModeEnabled && displayMode === 0) displayMode = 1;
    if (!readerScreen.hidden) displayPage();
});

// Tap starts TTS
const tapStartsTtsCheckbox = document.getElementById("tap-starts-tts");
let tapStartsTts = localStorage.getItem("tapStartsTts") === "true";
tapStartsTtsCheckbox.checked = tapStartsTts;
tapStartsTtsCheckbox.addEventListener("change", function() {
    tapStartsTts = tapStartsTtsCheckbox.checked;
    localStorage.setItem("tapStartsTts", tapStartsTts);
});

// Continue TTS on page turn
const continueTtsOnPageTurnCheckbox = document.getElementById("continue-tts-on-page-turn");
let continueTtsOnPageTurn = localStorage.getItem("continueTtsOnPageTurn") === "true";
continueTtsOnPageTurnCheckbox.checked = continueTtsOnPageTurn;
continueTtsOnPageTurnCheckbox.addEventListener("change", function() {
    continueTtsOnPageTurn = continueTtsOnPageTurnCheckbox.checked;
    localStorage.setItem("continueTtsOnPageTurn", continueTtsOnPageTurn);
});

// When speech reaches the end of a lesson: show the end card (default),
// or carry straight on into the next lesson.
const autoNextLessonCheckbox = document.getElementById("auto-next-lesson");
let autoNextLesson = localStorage.getItem("autoNextLesson") === "true";
autoNextLessonCheckbox.checked = autoNextLesson;
autoNextLessonCheckbox.addEventListener("change", function() {
    autoNextLesson = autoNextLessonCheckbox.checked;
    localStorage.setItem("autoNextLesson", autoNextLesson);
});

// Which lessons count as "next": only ones in the same language (default), or any.
const nextSameLanguageCheckbox = document.getElementById("next-same-language");
let nextSameLanguage = localStorage.getItem("nextSameLanguage") !== "false";
nextSameLanguageCheckbox.checked = nextSameLanguage;
nextSameLanguageCheckbox.addEventListener("change", function() {
    nextSameLanguage = nextSameLanguageCheckbox.checked;
    localStorage.setItem("nextSameLanguage", nextSameLanguage);
    if (!readerScreen.hidden) displayPage();      // the end card may offer a different lesson now
});

// Follow my place when switching language
const followTogetherCheckbox = document.getElementById("follow-together");
let followTogether = localStorage.getItem("followTogether") !== "false";
followTogetherCheckbox.checked = followTogether;
followTogetherCheckbox.addEventListener("change", function() {
    followTogether = followTogetherCheckbox.checked;
    localStorage.setItem("followTogether", followTogether);
});

// Speech speed
let ttsSpeed = 1.0;
const savedTtsSpeed = localStorage.getItem("ttsSpeed");
if (savedTtsSpeed !== null) {
    ttsSpeed = parseFloat(savedTtsSpeed);
    ttsSpeedSlider.value = ttsSpeed;
    ttsSpeedValue.textContent = ttsSpeed.toFixed(1) + "×";
}
ttsSpeedSlider.addEventListener("input", function() {
    ttsSpeed = parseFloat(ttsSpeedSlider.value);
    ttsSpeedValue.textContent = ttsSpeed.toFixed(1) + "×";
    localStorage.setItem("ttsSpeed", ttsSpeed);
});

// ═══════════════════════════════════════════════════════════════
//  TTS VOICES
// ═══════════════════════════════════════════════════════════════

let availableTtsVoices = [];
let selectedTtsVoiceURI = "";

function populateTtsVoices() {
    if (!currentBook) return;

    availableTtsVoices = window.speechSynthesis.getVoices();

    const languagePrefix = currentBook.l2Code.split("-")[0].toLowerCase();
    const matchingVoices = availableTtsVoices.filter(voice =>
        voice.lang.toLowerCase().split("-")[0] === languagePrefix
    );

    selectedTtsVoiceURI = localStorage.getItem(
        "ttsVoiceURI_" + currentBook.l2Code
    ) || "";

    ttsVoiceSelect.innerHTML = "";

    const automaticOption = document.createElement("option");
    automaticOption.value = "";
    automaticOption.textContent = "Automatic (default voice)";
    ttsVoiceSelect.appendChild(automaticOption);

    matchingVoices.sort((a, b) => {
        const preferred = currentBook.l2Code.toLowerCase();
        if (a.lang.toLowerCase() === preferred) return -1;
        if (b.lang.toLowerCase() === preferred) return 1;
        return a.name.localeCompare(b.name);
    });

    matchingVoices.forEach(voice => {
        const option = document.createElement("option");
        option.value = voice.voiceURI;
        option.textContent = `${voice.name} (${voice.lang})`;
        ttsVoiceSelect.appendChild(option);
    });

    if (selectedTtsVoiceURI &&
        matchingVoices.some(voice => voice.voiceURI === selectedTtsVoiceURI)) {
        ttsVoiceSelect.value = selectedTtsVoiceURI;
    } else {
        selectedTtsVoiceURI = "";
        ttsVoiceSelect.value = "";
    }
}

window.speechSynthesis.addEventListener("voiceschanged", populateTtsVoices);
populateTtsVoices();

ttsVoiceSelect.addEventListener("change", function() {
    selectedTtsVoiceURI = ttsVoiceSelect.value;
    if (currentBook) {
        localStorage.setItem("ttsVoiceURI_" + currentBook.l2Code, selectedTtsVoiceURI);
    }
});

// ═══════════════════════════════════════════════════════════════
//  SCREEN SWITCHING
// ═══════════════════════════════════════════════════════════════

function showHomeScreen() {
    readerScreen.hidden = true;
    homeScreen.hidden = false;
    document.body.classList.add("on-home");
    renderLibrary();
}

function showReaderScreen() {
    homeScreen.hidden = true;
    readerScreen.hidden = false;
    document.body.classList.remove("on-home");
}

// ═══════════════════════════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════════════════════════

function closeAllModals() {
    settingsPanel.hidden = true;
    importPanel.hidden = true;
    gotoPanel.hidden = true;
    languagesPanel.hidden = true;
    lessonMenuPanel.hidden = true;
}

function toggleSettings() {
    // If it's already open, close it. Otherwise, open it and close import.
    if (!settingsPanel.hidden) {
        settingsPanel.hidden = true;
    } else {
        settingsPanel.hidden = false;
        importPanel.hidden = true;
        refreshOfflineStatus();
    }
}

homeSettingsToggle.addEventListener("click", toggleSettings);
settingsToggle.addEventListener("click", toggleSettings);

// ═══════════════════════════════════════════════════════════════
//  LIBRARY RENDERING
// ═══════════════════════════════════════════════════════════════

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[c]));
}

// ── Languages: colours, flags and names ───────────────────────────
// Colours follow The Polyglot Gym hub. They are used on the home screen only
// (sections, cards, progress bars) and never on the reading text.
const LANGUAGE_INFO = {
    ru: { name: "Russian",    color: "#ff4757", soft: "rgba(255, 71, 87, 0.16)" },
    es: { name: "Spanish",    color: "#f59e0b", soft: "rgba(245, 158, 11, 0.16)" },
    ja: { name: "Japanese",   color: "#06b6d4", soft: "rgba(6, 182, 212, 0.16)" },
    it: { name: "Italian",    color: "#22c55e", soft: "rgba(34, 197, 94, 0.16)" },
    pt: { name: "Portuguese", color: "#eab308", soft: "rgba(234, 179, 8, 0.16)" },
    fr: { name: "French",     color: "#3b82f6", soft: "rgba(59, 130, 246, 0.16)" },
    en: { name: "English",    color: "#a855f7", soft: "rgba(168, 85, 247, 0.16)" }
};
const LANGUAGE_ORDER = ["ru", "es", "ja", "it", "pt", "fr", "en"];
const FLAG_CLASS = {
    "ru-RU": "flag-ru", "es-ES": "flag-es", "ja-JP": "flag-ja", "it-IT": "flag-it",
    "fr-FR": "flag-fr", "pt-PT": "flag-pt", "pt-BR": "flag-br",
    "en-GB": "flag-gb", "en-US": "flag-us"
};

function languagePrefix(code) {
    return (code || "").split("-")[0].toLowerCase();
}

function languageInfo(prefix) {
    return LANGUAGE_INFO[prefix] ||
        { name: prefix.toUpperCase(), color: "#94a3b8", soft: "rgba(148, 163, 184, 0.16)" };
}

// Which language chip is selected, and which languages you have hidden.
let homeFilter = "all";
let hiddenLanguages = new Set();
try {
    homeFilter = localStorage.getItem("homeLanguageFilter") || "all";
    const savedHidden = JSON.parse(localStorage.getItem("hiddenLanguages") || "[]");
    if (Array.isArray(savedHidden)) hiddenLanguages = new Set(savedHidden);
} catch (e) {}

function saveHomeChoices() {
    try {
        localStorage.setItem("homeLanguageFilter", homeFilter);
        localStorage.setItem("hiddenLanguages", JSON.stringify([...hiddenLanguages]));
    } catch (e) {}
}

// ── Progress ──────────────────────────────────────────────────────
function totalSentences(lesson) {
    return (lesson.units || []).reduce(
        (sum, u) => sum + (Array.isArray(u.l2) ? u.l2.length : 1), 0);
}

function readLessonPosition(lessonId) {
    try {
        const raw = localStorage.getItem(positionKey(lessonId));
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

// { state: "new" | "reading" | "done", current, total, percent, at }
function lessonStatus(lesson) {
    const total = Math.max(1, totalSentences(lesson));
    const position = readLessonPosition(lesson.id);
    if (!position || typeof position.sentence !== "number") {
        return { state: "new", current: 0, total: total, percent: 0, at: 0 };
    }
    const done = position.finished === true;
    const current = done ? total : Math.min(total, Math.floor(position.sentence) + 1);
    return {
        state: done ? "done" : "reading",
        current: current,
        total: total,
        percent: Math.round(current * 100 / total),
        at: position.at || 0
    };
}

// Languages that have at least one lesson, in a steady order.
function presentLanguages() {
    const found = new Set(library.map(l => languagePrefix(l.l2Code)));
    const known = LANGUAGE_ORDER.filter(p => found.has(p));
    const others = [...found].filter(p => !LANGUAGE_ORDER.includes(p)).sort();
    return known.concat(others);
}

function lessonCardHtml(lesson, status, isNextUp) {
    const flag = FLAG_CLASS[lesson.l2Code] || "";
    const l2Name = languageNames[lesson.l2Code] || languagePrefix(lesson.l2Code).toUpperCase();
    const l1Name = languageNames[lesson.l1Code] || languagePrefix(lesson.l1Code).toUpperCase();

    let progress;
    if (status.state === "done") {
        progress = '<span class="progress-track"><span class="progress-fill" style="width:100%"></span></span>' +
            '<span class="progress-text"><span class="done-tag"><svg width="14" height="14"><use href="#i-check"/></svg>Done</span>' +
            '<span>· ' + status.total + ' / ' + status.total + '</span></span>';
    } else if (status.state === "reading") {
        progress = '<span class="progress-track"><span class="progress-fill" style="width:' + status.percent + '%"></span></span>' +
            '<span class="progress-text"><span><b>' + status.current + '</b> / ' + status.total +
            ' · ' + status.percent + '%</span></span>';
    } else {
        progress = '<span class="progress-text"><span>Not started</span></span>';
    }

    return '<div class="lesson-card">' +
        '<button type="button" class="lesson-open" data-open="' + escapeHtml(lesson.id) + '">' +
            '<span class="lesson-head">' +
                '<span class="flag ' + flag + '" aria-hidden="true"></span>' +
                '<span class="lesson-text">' +
                    '<span class="lesson-title" style="display:block">' + escapeHtml(lesson.title) + '</span>' +
                    '<span class="lesson-meta" style="display:block">' + escapeHtml(l2Name) + ' → ' + escapeHtml(l1Name) +
                        (isNextUp ? ' · <span class="next-up">Next up</span>' : '') + '</span>' +
                '</span>' +
                '<span class="lang-badge">' + escapeHtml(languagePrefix(lesson.l2Code).toUpperCase()) + '</span>' +
            '</span>' +
            progress +
        '</button>' +
        '<button type="button" class="lesson-menu" data-menu="' + escapeHtml(lesson.id) + '" ' +
            'title="Rename or delete" aria-label="Lesson options: ' + escapeHtml(lesson.title) + '">' +
            '<svg width="18" height="18"><use href="#i-more"/></svg></button>' +
        '</div>';
}

function renderLibrary() {
    const scrollTop = libraryList.scrollTop;

    if (library.length === 0) {
        addLessonLabel.textContent = "Add lesson";
        libraryList.innerHTML =
            '<p class="empty-state">No lessons yet.<br>Tap "Add lesson" to import one.</p>';
        return;
    }

    const present = presentLanguages();
    const visible = present.filter(p => !hiddenLanguages.has(p));
    if (homeFilter !== "all" && !visible.includes(homeFilter)) homeFilter = "all";

    // Lessons in each visible language, in the order they were imported
    // (so chapters read in sequence), with their progress.
    const byLanguage = {};
    visible.forEach(prefix => {
        byLanguage[prefix] = library
            .map((lesson, index) => ({ lesson: lesson, index: index }))
            .filter(entry => languagePrefix(entry.lesson.l2Code) === prefix)
            .sort((a, b) => ((a.lesson.createdAt || 0) - (b.lesson.createdAt || 0)) || (a.index - b.index))
            .map(entry => ({ lesson: entry.lesson, status: lessonStatus(entry.lesson) }));
    });

    // "Next up": the first lesson not yet started, once you have started or finished another in that language
    const nextUpId = {};
    visible.forEach(prefix => {
        const entries = byLanguage[prefix];
        if (entries.some(e => e.status.state !== "new")) {
            const firstNew = entries.find(e => e.status.state === "new");
            if (firstNew) nextUpId[prefix] = firstNew.lesson.id;
        }
    });

    // Continue card: the unfinished lesson you read most recently
    let latest = null;
    visible.forEach(prefix => byLanguage[prefix].forEach(entry => {
        if (entry.status.state === "reading" && entry.status.at > 0 &&
            (!latest || entry.status.at > latest.status.at)) latest = entry;
    }));

    let html = "";
    if (latest) {
        const info = languageInfo(languagePrefix(latest.lesson.l2Code));
        html += '<button type="button" class="continue-card" data-open="' + escapeHtml(latest.lesson.id) +
            '" style="--c:' + info.color + '">' +
            '<span class="continue-text"><span class="continue-label">Continue reading</span>' +
            '<span class="continue-title">' + escapeHtml(latest.lesson.title) + '</span></span>' +
            '<span class="continue-go">' + latest.status.current + ' / ' + latest.status.total + ' →</span></button>';
    }

    // Language chips (All, one per visible language) and the "choose languages" button
    html += '<div class="chips" role="group" aria-label="Filter by language">' +
        '<button type="button" class="chip' + (homeFilter === "all" ? ' on' : '') + '" data-filter="all" ' +
        'aria-pressed="' + (homeFilter === "all") + '">All</button>';
    visible.forEach(prefix => {
        const info = languageInfo(prefix);
        const on = homeFilter === prefix;
        html += '<button type="button" class="chip lang' + (on ? ' on' : '') + '" data-filter="' + prefix +
            '" aria-pressed="' + on + '" style="--c:' + info.color + ';--soft:' + info.soft + '">' +
            escapeHtml(info.name) + '</button>';
    });
    html += '<button type="button" class="chip manage" data-action="languages" ' +
        'aria-label="Choose which languages to show" title="Languages">' +
        '<svg width="18" height="18"><use href="#i-sliders"/></svg></button></div>';

    // Sections: the language you read most recently comes first
    const shown = (homeFilter === "all" ? visible : [homeFilter]).slice();
    const newest = prefix => Math.max(0, ...byLanguage[prefix].map(e => e.status.at));
    shown.sort((a, b) => (newest(b) - newest(a)) || (visible.indexOf(a) - visible.indexOf(b)));

    if (shown.length === 0) {
        html += '<p class="empty-state">All languages are hidden.<br>Use the button above to show them.</p>';
    }
    shown.forEach(prefix => {
        const info = languageInfo(prefix);
        html += '<section class="lang-section" style="--c:' + info.color + '"><h2>' +
            escapeHtml(info.name) + '</h2>' +
            byLanguage[prefix].map(e => lessonCardHtml(e.lesson, e.status, nextUpId[prefix] === e.lesson.id)).join("") +
            '</section>';
    });

    libraryList.innerHTML = html;
    libraryList.scrollTop = scrollTop;
    addLessonLabel.textContent = homeFilter === "all"
        ? "Add lesson" : "Add " + languageInfo(homeFilter).name + " lesson";
}

// One listener for everything on the home list (cards, chips, delete buttons)
libraryList.addEventListener("click", function(event) {
    const target = event.target.closest("[data-open], [data-menu], [data-filter], [data-action]");
    if (!target) return;
    if (target.dataset.open) {
        openLesson(target.dataset.open);
    } else if (target.dataset.menu) {
        openLessonMenu(target.dataset.menu);
    } else if (target.dataset.filter) {
        homeFilter = target.dataset.filter;
        saveHomeChoices();
        renderLibrary();
    } else if (target.dataset.action === "languages") {
        openLanguagesPanel();
    }
});

// ── Choosing which languages to show ──────────────────────────────
function openLanguagesPanel() {
    languagesList.innerHTML = presentLanguages().map(prefix => {
        const info = languageInfo(prefix);
        const count = library.filter(l => languagePrefix(l.l2Code) === prefix).length;
        return '<label class="language-row" style="--c:' + info.color + '">' +
            '<span class="language-dot"></span>' +
            '<span class="language-name">' + escapeHtml(info.name) + '</span>' +
            '<span class="language-count">' + count + ' lesson' + (count === 1 ? '' : 's') + '</span>' +
            '<input type="checkbox" class="switch" data-lang="' + prefix + '"' +
            (hiddenLanguages.has(prefix) ? '' : ' checked') + '></label>';
    }).join("");
    languagesPanel.hidden = false;
}

languagesList.addEventListener("change", function(event) {
    const box = event.target.closest("input[data-lang]");
    if (!box) return;
    if (box.checked) hiddenLanguages.delete(box.dataset.lang);
    else hiddenLanguages.add(box.dataset.lang);
    saveHomeChoices();
    renderLibrary();
});

function closeLanguagesPanel() {
    languagesPanel.hidden = true;
}
document.getElementById("languages-close").addEventListener("click", closeLanguagesPanel);
document.getElementById("languages-done").addEventListener("click", closeLanguagesPanel);
languagesPanel.addEventListener("click", function(event) {
    if (event.target === languagesPanel) closeLanguagesPanel();
});

// ── Rename or delete a lesson ─────────────────────────────────────
let menuLessonId = null;

function openLessonMenu(lessonId) {
    const lesson = library.find(l => l.id === lessonId);
    if (!lesson) return;
    menuLessonId = lessonId;
    lessonNameInput.value = lesson.title;
    lessonMenuPanel.hidden = false;
}

function closeLessonMenu() {
    lessonMenuPanel.hidden = true;
    menuLessonId = null;
}

function saveLessonName() {
    const lesson = library.find(l => l.id === menuLessonId);
    const name = lessonNameInput.value.trim();
    if (!lesson) { closeLessonMenu(); return; }
    if (name === "") { lessonNameInput.focus(); return; }      // a lesson needs a name

    const oldName = lesson.title;
    lesson.title = name;
    if (!saveLibrary()) {
        lesson.title = oldName;
        alert("The new name could not be saved because the device storage is full.");
        return;
    }
    closeLessonMenu();
    renderLibrary();
}

document.getElementById("lesson-menu-close").addEventListener("click", closeLessonMenu);
document.getElementById("lesson-name-save").addEventListener("click", saveLessonName);
document.getElementById("lesson-delete-button").addEventListener("click", function() {
    const lessonId = menuLessonId;
    closeLessonMenu();
    if (lessonId) deleteLesson(lessonId);                       // asks "Delete ...?" first
});
lessonNameInput.addEventListener("keydown", function(event) {
    if (event.key === "Enter") { event.preventDefault(); saveLessonName(); }
});
lessonMenuPanel.addEventListener("click", function(event) {
    if (event.target === lessonMenuPanel) closeLessonMenu();     // tap outside the card
});

// When you press "Add lesson" the import screen starts on the right languages:
// the language you are viewing, otherwise the ones you used last time.
function applyImportLanguageDefaults() {
    const hasOption = (select, value) => [...select.options].some(o => o.value === value);
    let l2 = "es-ES";
    let l1 = "en-GB";
    try {
        l2 = localStorage.getItem("lastImportL2") || l2;
        l1 = localStorage.getItem("lastImportL1") || l1;
    } catch (e) {}

    if (homeFilter !== "all") {
        const mine = library
            .filter(l => languagePrefix(l.l2Code) === homeFilter)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        if (mine.length > 0) {
            l2 = mine[0].l2Code;
            l1 = mine[0].l1Code || l1;
        } else {
            const option = [...l2LanguageSelect.options].find(o => languagePrefix(o.value) === homeFilter);
            if (option) l2 = option.value;
        }
    }
    if (hasOption(l2LanguageSelect, l2)) l2LanguageSelect.value = l2;
    if (hasOption(l1LanguageSelect, l1)) l1LanguageSelect.value = l1;
}

function deleteLesson(lessonId) {
    const lesson = library.find(l => l.id === lessonId);
    if (!lesson) return;

    if (!confirm('Delete "' + lesson.title + '"?')) return;

    library = library.filter(l => l.id !== lessonId);
    saveLibrary();
    try { localStorage.removeItem(positionKey(lessonId)); } catch (e) {}

    if (currentLessonId === lessonId) {
        currentLessonId = null;
        currentBook = null;
        showHomeScreen();
    } else {
        renderLibrary();
    }
}

// ═══════════════════════════════════════════════════════════════
//  OPENING A LESSON
// ═══════════════════════════════════════════════════════════════

// options.replace   : swap the current history entry (moving from one lesson to the next)
// options.fromStart : ignore the saved place and begin at the first sentence
// options.autoplay  : start reading aloud straight away
function openLesson(lessonId, options = {}) {
    const lesson = library.find(l => l.id === lessonId);
    if (!lesson) return;

    if (currentLessonId) {              // moving on from another lesson: silence it
        cancelSpeech();
        isSpeaking = false;
        ttsStopped = false;
        setTtsButtonState("play");
    }
    saveCurrentPosition();

    if (options.replace) history.replaceState({ view: 'reader' }, '', '#reader');
    else history.pushState({ view: 'reader' }, '', '#reader');

    currentLessonId = lessonId;
    currentBook = {
        l2Code: lesson.l2Code,
        l2Name: lesson.l2Name,
        l1Code: lesson.l1Code,
        l1Name: lesson.l1Name
    };

    readingUnits = lesson.units.map(u => {
        const l2 = Array.isArray(u.l2) ? u.l2 : [u.l2 || ""];
        const l1 = Array.isArray(u.l1) ? u.l1 : [u.l1 || ""];
        const l3Raw = Array.isArray(u.l3) ? u.l3 : (u.l3 ? [u.l3] : []);
        const l3 = l2.map((_, i) => String(l3Raw[i] ?? ""));   // one entry per sentence, "" where empty
        return { l2, l1, l3 };
    });

    pages = [];
    lastPageKey = "";
    currentPage = 0;
    currentSentenceIndex = 0;
    displayMode = 2;

    // Make reader visible first — pagination needs real clientHeight
    showReaderScreen();

    populateTtsVoices();
    paginateReadingUnits();

    // Restore saved position
    const saved = loadSavedPosition(lesson);
    const place = locateGlobalSentence(options.fromStart ? 0 : saved.sentence);
    currentPage = place.page;
    currentSentenceIndex = place.sentence;

    let restoredMode = saved.mode;
    if (restoredMode === 0 && !thirdModeEnabled) restoredMode = 2;
    displayMode = restoredMode;

    displayPage();
    if (options.autoplay) startTts();
}

function goHome() {
    gotoPanel.hidden = true;
    cancelSpeech();
    isSpeaking = false;
    ttsStopped = false;
    setTtsButtonState("play");
    
    saveCurrentPosition();
    currentLessonId = null;
    currentBook = null;
    showHomeScreen();
}

homeButton.addEventListener("click", function() {
    history.back(); // This triggers the popstate event, which calls goHome()
});

// ═══════════════════════════════════════════════════════════════
//  IMPORT FLOW
// ═══════════════════════════════════════════════════════════════

let pendingImportFile = null;

addLessonButton.addEventListener("click", function() {
    closeAllModals();
    applyImportLanguageDefaults();
    importPanel.hidden = false;
    importTitleInput.value = "";
    importFileInput.value = "";
    fileNameDisplay.textContent = "No file selected";
    pendingImportFile = null;
    importConfirmButton.disabled = true;
});

importClose.addEventListener("click", function() {
    importPanel.hidden = true;
});

importFileInput.addEventListener("change", function() {
    const file = importFileInput.files[0];
    if (!file) {
        pendingImportFile = null;
        fileNameDisplay.textContent = "No file selected";
        importConfirmButton.disabled = true;
        return;
    }
    pendingImportFile = file;
    fileNameDisplay.textContent = file.name;
    if (!importTitleInput.value) {
        importTitleInput.value = file.name.replace(/\.(xlsx|xls|csv)$/i, "");
    }
    importConfirmButton.disabled = false;
});

importConfirmButton.addEventListener("click", async function() {
    if (!pendingImportFile) return;

    if (typeof XLSX === "undefined") {
        alert("The spreadsheet reader could not be loaded. Its file " +
              "(xlsx.full.min.js) is missing from the app, and there is no " +
              "internet connection to fetch a copy. Please connect and " +
              "reload the app, then try again.");
        return;
    }

    const title = importTitleInput.value.trim() ||
                  pendingImportFile.name.replace(/\.(xlsx|xls|csv)$/i, "");
    const l2Code = l2LanguageSelect.value;
    const l1Code = l1LanguageSelect.value;

    try {
        const units = await parseExcelFile(pendingImportFile, l2Code, l1Code);

        if (units.length === 0) {
            alert("No reading text was found in this spreadsheet.");
            return;
        }

        const lesson = {
            id: "les_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
            title: title,
            l2Code: l2Code,
            l2Name: languageNames[l2Code],
            l1Code: l1Code,
            l1Name: languageNames[l1Code],
            units: units,
            position: { page: 0, sentence: 0, mode: 2 },
            createdAt: Date.now()
        };

        library.push(lesson);
        if (!saveLibrary()) {
            library.pop();
            alert("This lesson could not be saved because the device " +
                  "storage is full. Delete a lesson you no longer need, " +
                  "then import again.");
            return;
        }

        try {
            localStorage.setItem("lastImportL2", l2Code);
            localStorage.setItem("lastImportL1", l1Code);
        } catch (e) {}

        // Make sure the lesson you just added is visible on the home screen
        const importedLanguage = languagePrefix(l2Code);
        hiddenLanguages.delete(importedLanguage);
        if (homeFilter !== "all") homeFilter = importedLanguage;
        saveHomeChoices();

        importPanel.hidden = true;
        renderLibrary();
    } catch (error) {
        alert("There was a problem reading this file. Please check that " +
              "it is an Excel or CSV file with the translation in column A " +
              "and the original language in column B (column C is optional).");
        console.error(error);
    }
});

async function parseExcelFile(file, l2Code, l1Code) {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data);
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: "" });

    const l2Name = languageNames[l2Code];
    const l1Name = languageNames[l1Code];

    function normaliseHeading(value) {
        return String(value).trim().toLowerCase();
    }

    const l2Headings = ["l2", l2Name.toLowerCase(), l2Code.toLowerCase()];
    const l1Headings = ["l1", l1Name.toLowerCase(), l1Code.toLowerCase()];

    // Columns: A = translation (L1), B = original (L2), C = third mode (optional).
    let startRow = 0;
    if (rows.length > 0) {
        const firstColumn = normaliseHeading(rows[0][0]);
        const secondColumn = normaliseHeading(rows[0][1]);
        if (l1Headings.includes(firstColumn) && l2Headings.includes(secondColumn)) {
            startRow = 1;
        }
    }

    return rows.slice(startRow)
        .map(row => ({
            l1: [String(row[0] ?? "").trim()],
            l2: [String(row[1] ?? "").trim()],
            l3: [String(row[2] ?? "").trim()]
        }))
        .filter(unit => unit.l1[0] !== "" || unit.l2[0] !== "" || unit.l3[0] !== "");
}

// ═══════════════════════════════════════════════════════════════
//  PAGINATION
// ═══════════════════════════════════════════════════════════════

function paginateReadingUnits() {

    const availableHeight = readingArea.clientHeight - 40;
    const availableWidth = readingArea.clientWidth;

    // Remember exactly which sentence you are on, so we can find it again
    // after the pages are rebuilt.
    const anchorSentence = currentGlobalSentence();
    const wasOnEnd = !!pages[currentPage]?.isEnd;

    if (availableHeight <= 0 || !availableWidth) {
        // Can't measure right now: fall back to one unit per page.
        let counter = 0;
        pages = readingUnits.map(function(unit, index) {
            const l2 = Array.isArray(unit.l2) ? unit.l2 : [unit.l2 || ""];
            const l1 = Array.isArray(unit.l1) ? unit.l1 : [unit.l1 || ""];
            const l3 = Array.isArray(unit.l3) ? unit.l3 : [];
            const page = { l2: l2.slice(), l1: l1.slice(),
                           l3: l2.map((_, i) => l3[i] ?? ""),
                           startUnitIndex: index, endUnitIndex: index,
                           startSentence: counter };
            counter += l2.length;
            return page;
        });
        pages.push(makeEndPage(readingUnits.reduce((sum, unit) =>
            sum + (Array.isArray(unit.l2) ? unit.l2.length : 1), 0)));
        lastPaginatedWidth = 0;
        lastPaginatedHeight = 0;
        const fallbackPlace = locateGlobalSentence(anchorSentence);
        currentPage = wasOnEnd ? pages.length - 1 : fallbackPlace.page;
        currentSentenceIndex = wasOnEnd ? 0 : fallbackPlace.sentence;
        return;
    }
    const textStyle = getComputedStyle(readingArea);
    const currentFontSize = parseFloat(textStyle.fontSize);
    const paragraphMargin = currentFontSize * 0.8;

    const measureBox = document.createElement("div");
    measureBox.style.position = "absolute";
    measureBox.style.visibility = "hidden";
    measureBox.style.left = "-10000px";
    measureBox.style.top = "0";
    measureBox.style.width = availableWidth + "px";
    measureBox.style.fontFamily = textStyle.fontFamily;
    measureBox.style.fontSize = textStyle.fontSize;
    measureBox.style.lineHeight = textStyle.lineHeight;
    measureBox.style.fontWeight = textStyle.fontWeight;
    measureBox.style.letterSpacing = textStyle.letterSpacing;
    measureBox.style.overflowWrap = "break-word";
    document.body.appendChild(measureBox);

    function measureTexts(texts, lang) {
        let totalHeight = 0;
        texts.forEach(function(text) {
            const paragraph = document.createElement("p");
            paragraph.textContent = text;
            if (lang) paragraph.lang = lang;
            paragraph.style.margin = `0 0 ${paragraphMargin}px 0`;
            measureBox.appendChild(paragraph);
            totalHeight += paragraph.getBoundingClientRect().height;
            totalHeight += paragraphMargin;
            paragraph.remove();
        });
        return totalHeight;
    }

    const newPages = [];
    let currentPageData = null;
    let l2Height = 0;
    let l1Height = 0;
    let l3Height = 0;
    let sentenceCounter = 0;   // L2 sentences seen so far, across the whole lesson

    function finishPage(endIndex) {
        if (!currentPageData) return;
        currentPageData.endUnitIndex = endIndex;
        newPages.push(currentPageData);
    }

    readingUnits.forEach(function(unit, index) {
        const l2Texts = Array.isArray(unit.l2) ? unit.l2 : [unit.l2 || ""];
        const l1Texts = Array.isArray(unit.l1) ? unit.l1 : [unit.l1 || ""];

        // Third mode text: one entry per sentence ("" where empty). It only
        // takes up room on the page if this unit really has some.
        const l3Raw = Array.isArray(unit.l3) ? unit.l3 : [];
        const l3Texts = l2Texts.map((_, i) => String(l3Raw[i] ?? ""));
        const hasL3 = l3Texts.some(Boolean);

        const newL2Height = measureTexts(l2Texts, currentBook?.l2Code);
        const newL1Height = measureTexts(l1Texts, currentBook?.l1Code);
        const newL3Height = hasL3
            ? measureTexts(l3Texts.map(t => t || "\u00a0"))
            : 0;

        // Every mode shares the same page breaks, so the tallest of the three decides.
        const wouldOverflow =
            Math.max(l2Height + newL2Height, l1Height + newL1Height,
                     l3Height + newL3Height) > availableHeight;

        if (wouldOverflow && currentPageData) {
            finishPage(index - 1);
            currentPageData = null;
            l2Height = 0;
            l1Height = 0;
            l3Height = 0;
        }

        if (!currentPageData) {
            currentPageData = {
                l2: [], l1: [], l3: [],
                startUnitIndex: index,
                startSentence: sentenceCounter
            };
        }

        currentPageData.l2.push(...l2Texts);
        currentPageData.l1.push(...l1Texts);
        currentPageData.l3.push(...l3Texts);
        l2Height += newL2Height;
        l1Height += newL1Height;
        l3Height += newL3Height;
        sentenceCounter += l2Texts.length;
    });

    finishPage(readingUnits.length - 1);
    measureBox.remove();

    newPages.push(makeEndPage(sentenceCounter));   // the end card is always the last page
    pages = newPages;
    lastPaginatedWidth = readingArea.clientWidth;
    lastPaginatedHeight = readingArea.clientHeight;

    // Put you back on the same sentence, wherever it landed in the new pages.
    if (wasOnEnd) {
        currentPage = pages.length - 1;          // stay on the end card
        currentSentenceIndex = 0;
    } else {
        const place = locateGlobalSentence(anchorSentence);
        currentPage = place.page;
        currentSentenceIndex = place.sentence;
    }
}

// ═══════════════════════════════════════════════════════════════
//  DISPLAY
// ═══════════════════════════════════════════════════════════════

function displayPage() {

    if (!pages[currentPage]) {
        readingArea.innerHTML = "";
        pageNumber.textContent = "0 / 0";
        updateScrollButtons();
        return;
    }

    const page = pages[currentPage];
    const onEnd = !!page.isEnd;                       // the end card, not a page of text
    const thirdHasText = !onEnd && (page.l3 || []).some(Boolean);

    // Rebuilding the text (which happens whenever the highlight moves) would
    // normally snap a scrolled page back to the top. Note where we were, so
    // we can go back there if this is still the same page.
    const pageKey = pages[currentPage].startSentence + ":" +
                    lastPaginatedWidth + "x" + lastPaginatedHeight + ":" +
                    readingArea.style.fontSize + ":" + readingArea.style.lineHeight;
    const samePage = (pageKey === lastPageKey);
    const modeSwitched = samePage && displayMode !== lastRenderMode;
    const sameView = samePage && !modeSwitched;   // exactly what is already on screen
    const sentenceMoved = (currentSentenceIndex !== lastRenderSentence);
    const previousScrollTop = (pendingScrollTarget !== null)
        ? pendingScrollTarget
        : readingArea.scrollTop;

    if (!samePage) {
        heldReadingPoint = null;
        scrollByMode = {};
    }
    if (modeSwitched && readingArea.children.length > 0) {
        // Leaving a language: remember where we were in it, before it is redrawn.
        scrollByMode[lastRenderMode] = previousScrollTop;
        heldReadingPoint = captureReadingPoint(previousScrollTop);
    }

    readingArea.innerHTML = "";

    // Which text to show: L1, L2, or the third mode (only if it has any text on this page).
    const texts = onEnd ? []
        : displayMode === 1 ? page.l1
        : displayMode === 2 ? page.l2
        : (thirdHasText ? page.l3 : []);

    // Tell the browser which language this text is in, so it picks the right
    // letter shapes (this matters most for Japanese) and screen readers
    // pronounce it properly.
    const textLang = onEnd ? ""
                   : displayMode === 1 ? currentBook?.l1Code
                   : displayMode === 2 ? currentBook?.l2Code : "";
    if (textLang) readingArea.setAttribute("lang", textLang);
    else readingArea.removeAttribute("lang");

    readingArea.innerHTML = onEnd ? buildEndCardHtml() : texts.map((sentence, index) => {
        const highlight =
            ttsHighlightEnabled && index === currentSentenceIndex
                ? ' class="tts-current-sentence"'
                : '';
        // In the third mode, an empty cell still keeps its line so the rest stays lined up.
        const shown = escapeHtml(sentence) || (displayMode === 0 ? "&nbsp;" : "");
        return `<p${highlight}>${shown}</p>`;
    }).join("");

    if (sameView) {
        readingArea.scrollTop = previousScrollTop;
    } else if (modeSwitched) {
        if (followTogether) applyReadingPoint(heldReadingPoint);
        else readingArea.scrollTop = scrollByMode[displayMode] || 0;
    } else {
        readingArea.scrollTop = 0;              // a different page starts at the top
    }
    if (!sameView) {
        clearTimeout(pendingScrollTimer);
        pendingScrollTarget = null;
    }
    if (!onEnd && (!samePage || sentenceMoved)) {
        keepCurrentSentenceInView(samePage);    // glide if still on the same page
    }
    lastPageKey = pageKey;
    lastRenderMode = displayMode;
    lastRenderSentence = currentSentenceIndex;
    updateScrollButtons();

    const l1Short = (currentBook?.l1Code || "").split("-")[0].toUpperCase();
    const l2Short = (currentBook?.l2Code || "").split("-")[0].toUpperCase();
    const modeLabels = ["Aa", l1Short, l2Short];   // Aa = third mode

    modeLabel.textContent = modeLabels[displayMode] || "";
    modeLabel.classList.toggle("blank", displayMode === 0 && !thirdHasText);   // dim when there is nothing to show
    modeLabel.setAttribute("aria-label",
        "Display mode: " + (displayMode === 0 ? "third mode" : modeLabels[displayMode]) +
        ". Activate to change.");

    pageNumber.textContent = onEnd ? "End" : `${currentPage + 1} / ${realPageCount()}`;

    saveCurrentPositionSoon();
}

// ── Scrolling a page that has more text than fits ──────────────────
// The reader never scrolls by dragging (dragging is for turning pages and
// changing language). Instead: arrow buttons, plus automatic scrolling
// while speech is playing.

const SCROLL_EDGE_GAP = 24;   // keep text clear of the arrow buttons

function scrollReadingTo(top, smooth) {
    clearTimeout(pendingScrollTimer);
    if (smooth) {
        pendingScrollTarget = top;
        pendingScrollTimer = setTimeout(function() { pendingScrollTarget = null; }, 700);
        readingArea.scrollTo({ top: top, behavior: "smooth" });
    } else {
        pendingScrollTarget = null;
        readingArea.scrollTop = top;
    }
}

// Show an arrow only when there is hidden text in that direction.
function updateScrollButtons() {
    const hiddenBelow = readingArea.scrollTop + readingArea.clientHeight <
                        readingArea.scrollHeight - 2;
    const hiddenAbove = readingArea.scrollTop > 2;
    scrollDownButton.hidden = !hiddenBelow;
    scrollUpButton.hidden = !hiddenAbove;

    if (pendingScrollTarget !== null &&
        Math.abs(readingArea.scrollTop - pendingScrollTarget) < 1) {
        pendingScrollTarget = null;   // the glide has arrived
    }
}

readingArea.addEventListener("scroll", updateScrollButtons);

function scrollReadingBy(direction) {
    const step = Math.max(40, readingArea.clientHeight * 0.8);   // leaves a little overlap
    const maxTop = Math.max(0, readingArea.scrollHeight - readingArea.clientHeight);
    const current = (pendingScrollTarget !== null) ? pendingScrollTarget : readingArea.scrollTop;
    scrollReadingTo(Math.max(0, Math.min(maxTop, current + direction * step)), true);
}

scrollDownButton.addEventListener("click", function() { scrollReadingBy(1); });
scrollUpButton.addEventListener("click", function() { scrollReadingBy(-1); });

// Scroll just enough that the current sentence is on screen. If the sentence
// is taller than the screen, show its beginning.
function keepCurrentSentenceInView(smooth) {
    if (readingArea.scrollHeight <= readingArea.clientHeight + 2) return;   // everything fits
    const paragraph = readingArea.children[currentSentenceIndex];
    if (!paragraph) return;

    const areaRect = readingArea.getBoundingClientRect();
    const paragraphRect = paragraph.getBoundingClientRect();
    const top = paragraphRect.top - areaRect.top + readingArea.scrollTop;
    const bottom = top + paragraphRect.height;
    const viewTop = readingArea.scrollTop;
    const viewHeight = readingArea.clientHeight;

    let target = viewTop;
    if (paragraphRect.height > viewHeight - 2 * SCROLL_EDGE_GAP) {
        target = top - SCROLL_EDGE_GAP;                          // too tall: show the start
    } else if (top - SCROLL_EDGE_GAP < viewTop) {
        target = top - SCROLL_EDGE_GAP;                          // sticks out above
    } else if (bottom + SCROLL_EDGE_GAP > viewTop + viewHeight) {
        target = bottom + SCROLL_EDGE_GAP - viewHeight;          // sticks out below
    }

    const maxTop = Math.max(0, readingArea.scrollHeight - viewHeight);
    target = Math.max(0, Math.min(maxTop, target));
    if (Math.abs(target - viewTop) < 1) return;
    scrollReadingTo(target, smooth);
}

// Inside one very tall sentence: when the voice reports which word it is on,
// scroll down in steps so the spoken part stays on screen. This only ever
// moves downward, and only for sentences taller than most of the screen.
function followSpokenPosition(charIndex, textLength) {
    if (textLength <= 0) return;
    if (readingArea.scrollHeight <= readingArea.clientHeight + 2) return;
    const paragraph = readingArea.children[currentSentenceIndex];
    if (!paragraph) return;

    const areaRect = readingArea.getBoundingClientRect();
    const paragraphRect = paragraph.getBoundingClientRect();
    const viewHeight = readingArea.clientHeight;
    if (paragraphRect.height < viewHeight * 0.6) return;

    const top = paragraphRect.top - areaRect.top + readingArea.scrollTop;
    const fraction = Math.max(0, Math.min(1, charIndex / textLength));
    const spokenY = top + fraction * paragraphRect.height;   // rough spot of the spoken word

    const viewTop = (pendingScrollTarget !== null) ? pendingScrollTarget : readingArea.scrollTop;
    if (spokenY <= viewTop + viewHeight * 0.65) return;       // still comfortably on screen

    const maxTop = Math.max(0, readingArea.scrollHeight - viewHeight);
    scrollReadingTo(Math.min(maxTop, spokenY - viewHeight * 0.25), true);
}

// ── Keeping your place when you switch language ────────────────────
// Before the text is redrawn in the other language we note which sentence
// (and how far through it) is at the top of the screen. After the redraw we
// scroll the new text to the matching spot.

function captureReadingPoint(effectiveScrollTop) {
    const maxTop = readingArea.scrollHeight - readingArea.clientHeight;
    if (maxTop <= 2) return null;                       // everything fitted, nothing to match
    const overall = Math.max(0, Math.min(1, effectiveScrollTop / maxTop));
    if (effectiveScrollTop <= 2) return { atStart: true, overall: 0 };
    if (effectiveScrollTop >= maxTop - 2) return { atEnd: true, overall: 1 };

    const kids = readingArea.children;
    const areaTop = readingArea.getBoundingClientRect().top;
    let index = 0;
    let fraction = 0;
    for (let i = 0; i < kids.length; i++) {
        const rect = kids[i].getBoundingClientRect();
        const top = rect.top - areaTop + readingArea.scrollTop;
        if (top > effectiveScrollTop + 1) break;
        index = i;
        fraction = rect.height > 0
            ? Math.max(0, Math.min(1, (effectiveScrollTop - top) / rect.height))
            : 0;
    }
    return { index: index, fraction: fraction, count: kids.length, overall: overall };
}

function applyReadingPoint(point) {
    const maxTop = Math.max(0, readingArea.scrollHeight - readingArea.clientHeight);
    if (!point || maxTop <= 0) {
        readingArea.scrollTop = 0;
        return;
    }

    let target;
    if (point.atStart) {
        target = 0;
    } else if (point.atEnd) {
        target = maxTop;
    } else {
        const kids = readingArea.children;
        if (kids.length === point.count && kids[point.index]) {
            const areaTop = readingArea.getBoundingClientRect().top;
            const rect = kids[point.index].getBoundingClientRect();
            const top = rect.top - areaTop + readingArea.scrollTop;
            target = top + point.fraction * rect.height;
        } else {
            target = point.overall * maxTop;            // sentence counts differ: use overall proportion
        }
    }
    readingArea.scrollTop = Math.max(0, Math.min(maxTop, target));
}

// ═══════════════════════════════════════════════════════════════
//  NAVIGATION HELPERS
// ═══════════════════════════════════════════════════════════════

// Modes: 1 = L1, 2 = L2, 0 = third mode (notes / romanised text).
// Order when swiping or tapping the mode label: L1 -> L2 -> third -> L1.
function cycleDisplayMode(direction) {
    if (pages[currentPage]?.isEnd) return;          // nothing to switch on the end card
    const order = thirdModeEnabled ? [1, 2, 0] : [1, 2];
    let position = order.indexOf(displayMode);
    if (position === -1) position = 0;
    position = (position + (direction === -1 ? order.length - 1 : 1)) % order.length;
    displayMode = order[position];
    ttsLog("mode -> " + displayMode);
    displayPage();
}

// ═══════════════════════════════════════════════════════════════
//  TTS ENGINE & STATE MACHINE
// ═══════════════════════════════════════════════════════════════

let isSpeaking = false;
let currentUtterance = null;
let currentSentenceIndex = 0;
let ttsStopped = false;
let ttsPage = -1;
let ttsSessionId = 0;

function setTtsButtonState(state) {
    if (state === "stop") {
        ttsIcon.setAttribute("href", "#i-stop");
        ttsButton.setAttribute("title", "Stop");
        ttsButton.setAttribute("aria-label", "Stop");
    } else if (state === "continue") {
        ttsIcon.setAttribute("href", "#i-play");
        ttsButton.setAttribute("title", "Continue");
        ttsButton.setAttribute("aria-label", "Continue");
    } else {
        ttsIcon.setAttribute("href", "#i-play");
        ttsButton.setAttribute("title", "Play");
        ttsButton.setAttribute("aria-label", "Play");
    }
}

// Event log. It always records into memory (no DOM writes, so it cannot
// change app behaviour). Show it with the "Show debug log" switch in
// Settings > Advanced, or by opening the app with ?debug in the URL.
const TTS_DEBUG = new URLSearchParams(location.search).has("debug");
const ttsLogLines = [];
let ttsLogVisible = TTS_DEBUG || localStorage.getItem("showDebugLog") === "true";

function renderTtsLog() {
    let box = document.getElementById("tts-debug");
    if (!ttsLogVisible) {
        if (box) box.remove();
        return;
    }
    if (!box) {
        box = document.createElement("pre");
        box.id = "tts-debug";
        box.style.cssText = "position:fixed;left:0;right:0;bottom:64px;margin:0;" +
            "padding:4px 8px;font:11px monospace;color:#0f0;background:rgba(0,0,0,.8);" +
            "z-index:999;pointer-events:none;white-space:pre-wrap;";
        document.body.appendChild(box);
    }
    box.textContent = "build " + APP_BUILD + "\n" + ttsLogLines.slice(-16).join("\n");
}

function ttsLog(message) {
    console.log("[tts]", message);
    ttsLogLines.push(message);
    if (ttsLogLines.length > 80) ttsLogLines.shift();
    if (ttsLogVisible) renderTtsLog();
}

const debugLogCheckbox = document.getElementById("show-debug-log");
debugLogCheckbox.checked = ttsLogVisible;
debugLogCheckbox.addEventListener("change", function() {
    ttsLogVisible = debugLogCheckbox.checked;
    localStorage.setItem("showDebugLog", ttsLogVisible);
    renderTtsLog();
});

// Record every raw pointer/click event and what it hit.
(function() {
    const describe = function(event) {
        const t = event.target;
        return (t.tagName || "?").toLowerCase() + (t.id ? "#" + t.id : "");
    };
    document.addEventListener("pointerdown", function(e) { ttsLog("pd " + describe(e)); }, true);
    document.addEventListener("pointerup", function(e) { ttsLog("pu " + describe(e)); }, true);
    document.addEventListener("pointercancel", function() { ttsLog("pointercancel"); }, true);
    document.addEventListener("click", function(e) { ttsLog("click " + describe(e)); }, true);
})();

// Invalidate the current session and silence the engine.
// cancel() is only called when the engine is actually busy: on Android
// Chrome an idle cancel() can swallow the next speak().
function cancelSpeech() {
    ttsSessionId++;
    currentUtterance = null;
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) {
        ttsLog("cancel()");
        synth.cancel();
    }
}

function stopTts(isPaused = true) {
    cancelSpeech();
    isSpeaking = false;
    ttsStopped = isPaused;
    setTtsButtonState(isPaused ? "continue" : "play");
}

function startTts() {
    if (!speechSupported) return;
    const synth = window.speechSynthesis;
    const wasBusy = synth.speaking || synth.pending;

    cancelSpeech();                       // bumps the session id
    const sessionId = ttsSessionId;

    isSpeaking = true;
    ttsStopped = false;
    setTtsButtonState("stop");
    ttsPage = currentPage;

    if (wasBusy) {
        // We just cancelled live audio: give the engine a moment to clear.
        setTimeout(function() {
            if (sessionId !== ttsSessionId || !isSpeaking || ttsStopped) return;
            speakNextSentence();
        }, 120);
    } else {
        // Engine idle: speak straight away, inside the tap gesture.
        speakNextSentence();
    }
}

function speakNextSentence(attempt = 0) {

    const sessionId = ttsSessionId;
    const sentences = pages[currentPage].l2;

    if (currentSentenceIndex >= sentences.length) {
        const nextPage = pages[currentPage + 1];
        if (nextPage && !nextPage.isEnd) {
            currentPage++;
            currentSentenceIndex = 0;
            ttsPage = currentPage;
            displayPage();
            speakNextSentence();
            return;
        }

        finishLessonSpeech();
        return;
    }

    const utterance = new SpeechSynthesisUtterance(sentences[currentSentenceIndex]);
    currentUtterance = utterance;
    let started = false;
    let wordEvents = 0;                       // how many "now on word N" reports the voice gave
    const sentenceLength = sentences[currentSentenceIndex].length;

    utterance.lang = currentBook ? currentBook.l2Code : "en-GB";

    if (selectedTtsVoiceURI) {
        const selectedVoice = availableTtsVoices.find(
            voice => voice.voiceURI === selectedTtsVoiceURI
        );
        if (selectedVoice) utterance.voice = selectedVoice;
    }

    utterance.rate = ttsSpeed;

    // True only while this exact utterance is the live one. Late events
    // from cancelled/retired utterances fail this check and are ignored.
    function isLive() {
        return !ttsStopped &&
               sessionId === ttsSessionId &&
               utterance === currentUtterance;
    }

    // Re-issue the same sentence (max 2 retries). Returns true if scheduled.
    function retry(reason) {
        if (attempt >= 2) return false;
        ttsLog("retry " + (attempt + 1) + " (" + reason + ")");
        currentUtterance = null;                 // retire this utterance
        const synth = window.speechSynthesis;
        if (synth.speaking || synth.pending) synth.cancel();
        setTimeout(function() {
            if (sessionId !== ttsSessionId || ttsStopped || !isSpeaking) return;
            speakNextSentence(attempt + 1);
        }, 200);
        return true;
    }

    utterance.onboundary = function(event) {
        if (!isLive()) return;
        if (event.name && event.name !== "word") return;
        wordEvents++;
        followSpokenPosition(event.charIndex || 0, sentenceLength);
    };

    utterance.onstart = function() {
        if (!isLive()) return;
        started = true;
        ttsLog("start");
    };

    utterance.onend = function() {
        if (!isLive()) return;
        ttsLog("end, word events: " + wordEvents);
        currentSentenceIndex++;
        speakNextSentence();
    };

    utterance.onerror = function(event) {
        if (!isLive()) return;
        ttsLog("error: " + event.error);

        // Android Chrome can fail the first utterance after a cancel()
        // with "interrupted"/"canceled". Try again before giving up.
        if ((event.error === "interrupted" || event.error === "canceled") &&
            retry(event.error)) return;

        isSpeaking = false;
        currentUtterance = null;
        setTtsButtonState("play");
    };

    // Call speak FIRST to preserve the user gesture window on Android
    ttsLog("speak (attempt " + attempt + ")");
    window.speechSynthesis.speak(utterance);

    // THEN update the UI (once per sentence)
    displayPage();

    // Watchdog: some engines drop the utterance without any event at all.
    setTimeout(function() {
        if (!isLive() || started) return;
        const synth = window.speechSynthesis;
        if (synth.speaking && !synth.pending) return;   // audio is playing anyway
        retry("no start");
    }, 700);
}

// ═══════════════════════════════════════════════════════════════
//  NAVIGATION HELPERS
// ═══════════════════════════════════════════════════════════════

function changePageWithTts(changeFn) {
    const wasPlaying = isSpeaking && !ttsStopped;
    
    cancelSpeech();
    changeFn();
    currentSentenceIndex = 0;
    ttsPage = currentPage;

    if (wasPlaying && continueTtsOnPageTurn && !pages[currentPage]?.isEnd) {
        startTts();
    } else {
        isSpeaking = false;
        ttsStopped = false;
        setTtsButtonState("play");
        displayPage();
    }
}

function goToPreviousPage() {
    if (currentPage > 0) changePageWithTts(function() { currentPage--; });
}

function goToNextPage() {
    if (currentPage < pages.length - 1) changePageWithTts(function() { currentPage++; });
}

function moveToSentence(direction) {
    if (pages[currentPage]?.isEnd) {                // on the end card: Up goes back to the text
        if (direction < 0 && realPageCount() > 0) {
            cancelSpeech();
            isSpeaking = false;
            ttsStopped = false;
            setTtsButtonState("play");
            currentPage = realPageCount() - 1;
            currentSentenceIndex = pages[currentPage].l2.length - 1;
            displayPage();
        }
        return;
    }

    const wasPlaying = isSpeaking && !ttsStopped;
    
    currentSentenceIndex += direction;

    if (currentSentenceIndex < 0) {
        if (currentPage > 0) {
            currentPage--;
            currentSentenceIndex = pages[currentPage].l2.length - 1;
        } else {
            currentSentenceIndex = 0;
            return;
        }
    }

    if (currentSentenceIndex >= pages[currentPage].l2.length) {
        if (currentPage < realPageCount() - 1) {
            currentPage++;
            currentSentenceIndex = 0;
        } else {
            currentSentenceIndex = pages[currentPage].l2.length - 1;
            return;
        }
    }

    if (wasPlaying) {
        startTts();
    } else {
        cancelSpeech();
        isSpeaking = false;
        ttsStopped = false;
        setTtsButtonState("play");
        displayPage();
    }
}

function jumpToSentence(index) {
    if (!pages[currentPage]) return;
    if (index < 0 || index >= pages[currentPage].l2.length) return;

    const wasPlaying = isSpeaking && !ttsStopped;
    const isCurrent = (index === currentSentenceIndex);
    ttsLog("jump i=" + index + " cur=" + currentSentenceIndex +
           " playing=" + wasPlaying + " tapStarts=" + tapStartsTts);

    if (!tapStartsTts) {
        if (wasPlaying && !isCurrent) {
            currentSentenceIndex = index;
            startTts();
        } else if (!isCurrent) {
            cancelSpeech();
            currentSentenceIndex = index;
            isSpeaking = false;
            ttsStopped = false;
            setTtsButtonState("play");
            displayPage();
        }
        return;
    }

    if (wasPlaying && isCurrent) {
        stopTts(true);
        return;
    }

    currentSentenceIndex = index;
    startTts();
}

// ═══════════════════════════════════════════════════════════════
//  END OF LESSON, AND GOING TO A PAGE
// ═══════════════════════════════════════════════════════════════

function goToStart() {
    changePageWithTts(function() { currentPage = 0; });
}

function goToEnd() {
    changePageWithTts(function() { currentPage = pages.length - 1; });   // the end card
}

function goToPage(pageIndex) {
    const count = realPageCount();
    if (count === 0) return;
    const target = Math.max(0, Math.min(pageIndex, count - 1));
    changePageWithTts(function() { currentPage = target; });
}

// The next lesson is the one added just after this one. With "stays in the
// same language" on (the default) it skips lessons in other languages.
function findNextLesson() {
    const current = library.find(l => l.id === currentLessonId);
    if (!current) return null;

    const languageOf = code => (code || "").split("-")[0].toLowerCase();
    const inOrder = library
        .map((lesson, index) => ({ lesson: lesson, index: index }))
        .sort((a, b) => ((a.lesson.createdAt || 0) - (b.lesson.createdAt || 0)) || (a.index - b.index))
        .map(entry => entry.lesson);

    const start = inOrder.findIndex(l => l.id === current.id);
    for (let i = start + 1; i < inOrder.length; i++) {
        const candidate = inOrder[i];
        if (!nextSameLanguage || languageOf(candidate.l2Code) === languageOf(current.l2Code)) {
            return candidate;
        }
    }
    return null;
}

function buildEndCardHtml() {
    const lesson = library.find(l => l.id === currentLessonId);
    const next = findNextLesson();

    let html = '<div class="end-card">' +
        '<div class="end-title">End of lesson</div>' +
        '<div class="end-lesson">' + escapeHtml(lesson ? lesson.title : "") + '</div>' +
        '<button type="button" class="primary-button" data-end-action="restart">Back to start</button>';

    if (next) {
        html += '<button type="button" class="primary-button" data-end-action="next">' +
                'Next lesson: ' + escapeHtml(next.title) + '</button>';
    } else {
        const languageName = currentBook && currentBook.l2Name;
        html += '<div class="end-hint">No more ' +
                (nextSameLanguage && languageName ? escapeHtml(languageName) + ' ' : '') +
                'lessons.</div>';
    }
    return html + '</div>';
}

// Speech has read the last sentence: carry on into the next lesson, or show the end card.
function finishLessonSpeech() {
    currentUtterance = null;
    isSpeaking = false;
    ttsStopped = false;
    setTtsButtonState("play");

    const next = autoNextLesson ? findNextLesson() : null;
    if (next) {
        ttsLog("end of lesson -> next lesson");
        currentPage = pages.length - 1;       // so this lesson is recorded as finished
        openLesson(next.id, { replace: true, fromStart: true, autoplay: true });
        return;
    }

    currentPage = pages.length - 1;                 // the end card
    currentSentenceIndex = 0;
    displayPage();
}

// Buttons on the end card
readingArea.addEventListener("click", function(event) {
    const button = event.target.closest("[data-end-action]");
    if (!button) return;
    if (button.dataset.endAction === "restart") {
        goToStart();
    } else if (button.dataset.endAction === "next") {
        const next = findNextLesson();
        if (next) openLesson(next.id, { replace: true, fromStart: true });
    }
});

// The page number is a button: tap it to jump around.
const gotoInput = document.getElementById("goto-input");
const gotoTotal = document.getElementById("goto-total");

function openGotoPanel() {
    if (!currentLessonId || realPageCount() === 0) return;
    gotoTotal.textContent = "of " + realPageCount();
    gotoInput.max = realPageCount();
    gotoInput.value = pages[currentPage]?.isEnd ? "" : String(currentPage + 1);
    updateGotoArrows();
    gotoPanel.hidden = false;
}

function closeGotoPanel() {
    gotoPanel.hidden = true;
}

const gotoPrev = document.getElementById("goto-prev");
const gotoNext = document.getElementById("goto-next");

// The number in the box, or (if it is empty) the page you are on now.
function gotoNumber() {
    const typed = parseInt(gotoInput.value, 10);
    if (Number.isFinite(typed)) return typed;
    return pages[currentPage]?.isEnd ? realPageCount() : currentPage + 1;
}

function updateGotoArrows() {
    const count = realPageCount();
    const number = gotoNumber();
    gotoPrev.disabled = number <= 1;
    gotoNext.disabled = number >= count;
}

// Arrows change the number in the box (you still press Go, or type instead).
function gotoStep(delta) {
    const count = realPageCount();
    if (count === 0) return;
    gotoInput.value = String(Math.max(1, Math.min(count, gotoNumber() + delta)));
    updateGotoArrows();
}

// Tap = one step; hold = keeps stepping, so big jumps are quick.
function holdToStep(button, delta) {
    let startTimer = null;
    let repeatTimer = null;
    function stop() {
        clearTimeout(startTimer);
        clearInterval(repeatTimer);
        startTimer = repeatTimer = null;
    }
    button.addEventListener("pointerdown", function() {
        if (button.disabled) return;
        gotoStep(delta);
        startTimer = setTimeout(function() {
            repeatTimer = setInterval(function() { gotoStep(delta); }, 90);
        }, 450);
    });
    ["pointerup", "pointerleave", "pointercancel", "blur"].forEach(function(name) {
        button.addEventListener(name, stop);
    });
    button.addEventListener("click", function(event) {     // keyboard or screen reader activation
        if (event.detail === 0) gotoStep(delta);
    });
}

function submitGoto() {
    const number = parseInt(gotoInput.value, 10);
    if (!Number.isFinite(number)) return;
    closeGotoPanel();
    goToPage(number - 1);
}

pageNumber.addEventListener("click", openGotoPanel);
holdToStep(gotoPrev, -1);
holdToStep(gotoNext, 1);
gotoInput.addEventListener("input", updateGotoArrows);
document.getElementById("goto-close").addEventListener("click", closeGotoPanel);
gotoPanel.addEventListener("click", function(event) {
    if (event.target === gotoPanel) closeGotoPanel();        // tap outside the card
});
document.getElementById("goto-go").addEventListener("click", submitGoto);
gotoInput.addEventListener("keydown", function(event) {
    if (event.key === "Enter") { event.preventDefault(); submitGoto(); }
});
document.getElementById("goto-start").addEventListener("click", function() {
    closeGotoPanel();
    goToStart();
});
document.getElementById("goto-end").addEventListener("click", function() {
    closeGotoPanel();
    goToEnd();
});

// ═══════════════════════════════════════════════════════════════
//  TTS BUTTON LISTENER
// ═══════════════════════════════════════════════════════════════

ttsButton.addEventListener("click", function() {
    if (!currentLessonId || pages.length === 0) return;
    if (!speechSupported) {
        alert("Text-to-speech is not supported by this browser.");
        return;
    }

    ttsLog("btn speaking=" + isSpeaking + " stopped=" + ttsStopped);

    if (isSpeaking && !ttsStopped) {
        stopTts(true);
        return;
    }

    if (pages[currentPage]?.isEnd) {        // play on the end card = read it again from the start
        currentPage = 0;
        currentSentenceIndex = 0;
    }
    startTts();
});

// ═══════════════════════════════════════════════════════════════
//  INPUT — SWIPE AND TAP
// ═══════════════════════════════════════════════════════════════

let swipeStartX = 0;
let swipeStartY = 0;
let swipeStartTime = 0;
let lastTouchTapAt = 0;
let isTrackingSwipe = false;

readingAreaSection.addEventListener("pointerdown", function(event) {
    if (event.pointerType !== "touch") return;
    if (event.target.closest("button")) return;

    swipeStartX = event.clientX;
    swipeStartY = event.clientY;
    swipeStartTime = performance.now();
    isTrackingSwipe = true;
});

readingAreaSection.addEventListener("pointerup", function(event) {
    if (!isTrackingSwipe) return;
    isTrackingSwipe = false;

    const differenceX = event.clientX - swipeStartX;
    const differenceY = event.clientY - swipeStartY;
    const minimumSwipe = 50;

    const moved = Math.max(Math.abs(differenceX), Math.abs(differenceY));

    // A short, nearly stationary touch is a tap. Handle it here instead of
    // waiting for the browser's synthesised click, which Chrome on Android
    // sometimes never delivers.
    if (moved < 10 && performance.now() - swipeStartTime < 600) {
        lastTouchTapAt = performance.now();
        handleReadingTap(event.clientY);
        return;
    }

    if (moved < minimumSwipe) return;

    if (Math.abs(differenceX) > Math.abs(differenceY)) {
        if (differenceX < 0) goToNextPage();
        else goToPreviousPage();
    } else {
        if (differenceY < 0) cycleDisplayMode(1);
        else cycleDisplayMode(-1);
    }
});

readingAreaSection.addEventListener("pointercancel", function() {
    isTrackingSwipe = false;
});

// Don't let Chrome select words in the reader. This also stops the
// "Tap to search" prompt, which is triggered by that selection.
document.addEventListener("selectstart", function(event) {
    const node = event.target.nodeType === 1 ? event.target : event.target.parentElement;
    if (node && node.closest(".reading-area")) event.preventDefault();
});

readingAreaSection.addEventListener("contextmenu", function(event) {
    event.preventDefault();   // long-press menu
});

// Tapping anywhere in the reading area counts. A tap on (or just beside) a
// sentence picks that sentence; a tap in empty space, or anywhere in blank
// mode where there is no text, acts on the current sentence.
function handleReadingTap(clientY) {
    const paragraphs = Array.from(readingArea.querySelectorAll("p"));
    const margin = 12;   // px of forgiveness around each paragraph

    let index = paragraphs.findIndex(function(p) {
        const rect = p.getBoundingClientRect();
        return clientY >= rect.top - margin && clientY <= rect.bottom + margin;
    });

    if (index === -1) {
        index = currentSentenceIndex;
        ttsLog("tap in empty space -> current sentence");
    }

    jumpToSentence(index);
}

// Fallback for mouse input and touches that weren't handled on pointerup.
readingAreaSection.addEventListener("click", function(event) {
    if (event.target.closest("button")) return;
    if (performance.now() - lastTouchTapAt < 800) return;   // already handled
    handleReadingTap(event.clientY);
});

modeLabel.addEventListener("click", function() {
    cycleDisplayMode(1);
});

// ═══════════════════════════════════════════════════════════════
//  KEYBOARD
// ═══════════════════════════════════════════════════════════════

document.addEventListener("keydown", function(event) {

    if (event.key === "Escape") {
        if (!settingsPanel.hidden) { settingsPanel.hidden = true; return; }
        if (!importPanel.hidden) { importPanel.hidden = true; return; }
        if (!gotoPanel.hidden) { gotoPanel.hidden = true; return; }
        if (!languagesPanel.hidden) { languagesPanel.hidden = true; return; }
        if (!lessonMenuPanel.hidden) { closeLessonMenu(); return; }
    }

    if (readerScreen.hidden) return;
    if (!settingsPanel.hidden) return;
    if (!importPanel.hidden) return;
    if (!gotoPanel.hidden) return;
    if (!languagesPanel.hidden) return;
    if (!lessonMenuPanel.hidden) return;

    if (event.target.matches("input, textarea, select") ||
        event.target.isContentEditable) return;

    if (event.repeat) return;

    if (event.code === "Space") {
        event.preventDefault();
        ttsButton.click();
    }

    if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        cycleDisplayMode(1);
    }

    if (event.key === "ArrowLeft") { goToPreviousPage(); }
    if (event.key === "ArrowRight") { goToNextPage(); }
    if (event.key === "ArrowUp") { moveToSentence(-1); }
    if (event.key === "ArrowDown") { moveToSentence(1); }
});

// ═══════════════════════════════════════════════════════════════
//  RESIZE
// ═══════════════════════════════════════════════════════════════

let resizeTimer = null;
window.addEventListener("resize", function() {
    if (readerScreen.hidden) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() {
        if (readerScreen.hidden) return;
        // Phone address bars sliding in and out fire "resize" without
        // changing the text box at all. Only re-flow when it really changed.
        if (readingArea.clientWidth === lastPaginatedWidth &&
            readingArea.clientHeight === lastPaginatedHeight) return;
        paginateReadingUnits();
        displayPage();
    }, 200);
});

window.addEventListener('popstate', function(event) {
    if (!readerScreen.hidden) {
        // We were in the reader, so transition to Home
        goHome();
    } else {
        // We are already on the Home screen.
        // Trap the back button so the app doesn't close.
        history.pushState({ view: 'home' }, '', '#home');
    }
});

// ═══════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════

library = loadLibrary();
seedLibraryIfEmpty();

(function addBuildStamp() {
    const body = settingsPanel.querySelector(".modal-body");
    if (!body) return;
    const stamp = document.createElement("div");
    stamp.textContent = "Build " + APP_BUILD;
    stamp.style.cssText = "text-align:center;color:#555;font-size:11px;padding:8px 0 24px;";
    body.appendChild(stamp);

    // A second small line under the build number: is offline mode working?
    offlineStatusEl = document.createElement("div");
    offlineStatusEl.style.cssText = "text-align:center;color:#555;font-size:11px;padding:0 0 24px;margin-top:-16px;";
    body.appendChild(offlineStatusEl);
})();

// ═══════════════════════════════════════════════════════════════
//  OFFLINE MODE (service worker)
// ═══════════════════════════════════════════════════════════════
// sw.js keeps a copy of the app on the phone. New versions are downloaded
// quietly in the background and only take over once the app has been fully
// closed and reopened, so nothing changes while you are in the middle of a lesson.

async function offlineStatusText() {
    if (!("serviceWorker" in navigator) || !window.caches) {
        return "Offline mode is not available in this browser";
    }
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return "Offline: setting up\u2026";
    if (reg.waiting && navigator.serviceWorker.controller) {
        return "Update downloaded \u2014 it starts next time you close and reopen the app";
    }
    if (reg.installing) return "Offline: saving the app\u2026";
    if (!navigator.serviceWorker.controller) return "Offline: almost ready \u2014 reopen the app once";
    const appCopy = await caches.match("app.js", { ignoreSearch: true });
    if (!appCopy) return "Offline: not saved yet";
    const readerCopy = await caches.match("xlsx.full.min.js", { ignoreSearch: true });
    return readerCopy
        ? "Offline ready"
        : "Offline ready, but importing lessons needs internet (spreadsheet reader file not found)";
}

function refreshOfflineStatus() {
    if (!offlineStatusEl) return;
    offlineStatusText()
        .then(function(text) { offlineStatusEl.textContent = text; })
        .catch(function() { offlineStatusEl.textContent = "Offline: status unknown"; });
}

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("controllerchange", refreshOfflineStatus);
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
        .then(function(reg) {
            reg.update().catch(function() {});   // look for a newer version now
            reg.addEventListener("updatefound", function() {
                const worker = reg.installing;
                if (!worker) return;
                worker.addEventListener("statechange", refreshOfflineStatus);
            });
            refreshOfflineStatus();
        })
        .catch(function(err) {
            if (typeof ttsLog === "function") ttsLog("service worker: " + err);
        });
}

// Set the initial history state
history.replaceState({ view: 'home' }, '', '#home');

showHomeScreen();

document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "hidden") saveCurrentPosition();
});

window.addEventListener("pagehide", function() {
    saveCurrentPosition();
    window.speechSynthesis.cancel();
});