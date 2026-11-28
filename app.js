// ═══════════════════════════════════════════════════════════════
//  SWITCHREADER — parallel-text lesson reader
// ═══════════════════════════════════════════════════════════════

const APP_BUILD = "2026-11-27d";   // shown at the bottom of Settings: tells you which build is running
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

// ── Speech speed, font size and line spacing ──────────────────
// Normally these three are the same for every language. With the switch
// "Remember separate settings for each language" turned on, they are saved
// under the language of the lesson that is open (its L2) instead.

let ttsSpeed = 1.0;
const LANG_SETTINGS_KEY = "switchreader-lang-settings";
const perLanguageCheckbox = document.getElementById("per-language-settings");
const settingsLanguageNote = document.getElementById("settings-language-note");
let perLanguageSettings = localStorage.getItem("perLanguageSettings") === "true";
perLanguageCheckbox.checked = perLanguageSettings;

function loadLanguageSettings() {
    try { return JSON.parse(localStorage.getItem(LANG_SETTINGS_KEY) || "{}") || {}; }
    catch (e) { return {}; }
}

function saveLanguageSettings(all) {
    try { localStorage.setItem(LANG_SETTINGS_KEY, JSON.stringify(all)); } catch (e) {}
}

// The language these three settings currently belong to (none = the shared set)
function editingLanguage() {
    return perLanguageSettings && currentBook ? currentBook.l2Code : null;
}

// The shared set (also the starting point for any language you haven't changed yet)
function sharedValues() {
    const font = parseFloat(localStorage.getItem("switchreader-font-size"));
    const spacing = parseFloat(localStorage.getItem("switchreader-line-spacing"));
    const speed = parseFloat(localStorage.getItem("ttsSpeed"));
    return {
        fontSize: isNaN(font) ? 22 : font,
        lineSpacing: isNaN(spacing) ? 150 : spacing,
        speed: isNaN(speed) ? 1.0 : speed
    };
}

// Show a value: move the slider, update its label, and apply it to the text/speech
function showFontSize(size) {
    fontSizeSlider.value = size;
    readingArea.style.fontSize = size + "px";
    fontSizeValue.textContent = size + "px";
}

function showLineSpacing(value) {
    lineSpacingSlider.value = value;
    const spacing = value / 100;
    readingArea.style.lineHeight = spacing;
    lineSpacingValue.textContent = spacing.toFixed(2);
}

function showSpeed(value) {
    ttsSpeed = value;
    ttsSpeedSlider.value = value;
    ttsSpeedValue.textContent = value.toFixed(1) + "×";
}

// Load the right set of values for whatever is open right now.
function applyLanguageSettings(relayout) {
    const values = sharedValues();
    const lang = editingLanguage();
    const mine = lang ? (loadLanguageSettings()[lang] || {}) : {};
    showFontSize(mine.fontSize ?? values.fontSize);
    showLineSpacing(mine.lineSpacing ?? values.lineSpacing);
    showSpeed(mine.speed ?? values.speed);
    if (relayout && !readerScreen.hidden) relayoutSoon();
}

// Save the three sliders where they belong (this language, or the shared set).
function saveSliderValues() {
    const values = {
        fontSize: parseFloat(fontSizeSlider.value),
        lineSpacing: parseFloat(lineSpacingSlider.value),
        speed: parseFloat(ttsSpeedSlider.value)
    };
    const lang = editingLanguage();
    if (lang) {
        const all = loadLanguageSettings();
        all[lang] = values;
        saveLanguageSettings(all);
    } else {
        localStorage.setItem("switchreader-font-size", values.fontSize);
        localStorage.setItem("switchreader-line-spacing", values.lineSpacing);
        localStorage.setItem("ttsSpeed", values.speed);
    }
}

// With the switch on, the sliders belong to a language, so they are locked
// on the home screen where no language is open. The voice is always tied
// to a language, so it is locked there either way.
function updateSettingsAvailability() {
    const lessonOpen = !!currentBook;
    const slidersLocked = perLanguageSettings && !lessonOpen;
    [fontSizeSlider, lineSpacingSlider, ttsSpeedSlider].forEach(function(slider) {
        slider.disabled = slidersLocked;
    });
    ttsVoiceSelect.disabled = !lessonOpen;

    let note = "";
    if (perLanguageSettings && lessonOpen) {
        note = "Settings for: " + currentBook.l2Name;
    } else if (slidersLocked) {
        note = "Open a lesson to change speech speed, font size, line spacing and voice. " +
               "They are saved separately for each language.";
    } else if (!lessonOpen) {
        note = "Open a lesson to choose a reading voice.";
    }
    settingsLanguageNote.textContent = note;
}

fontSizeSlider.addEventListener("input", function() {
    showFontSize(fontSizeSlider.value);
    saveSliderValues();
    if (!readerScreen.hidden) relayoutSoon();
});

lineSpacingSlider.addEventListener("input", function() {
    showLineSpacing(parseFloat(lineSpacingSlider.value));
    saveSliderValues();
    if (!readerScreen.hidden) relayoutSoon();
});

ttsSpeedSlider.addEventListener("input", function() {
    showSpeed(parseFloat(ttsSpeedSlider.value));
    saveSliderValues();
});

perLanguageCheckbox.addEventListener("change", function() {
    perLanguageSettings = perLanguageCheckbox.checked;
    localStorage.setItem("perLanguageSettings", perLanguageSettings);
    applyLanguageSettings(true);
    updateSettingsAvailability();
});

// Initialise the style immediately on load
applyLanguageSettings(false);

// Highlight
let ttsHighlightEnabled = localStorage.getItem("ttsHighlightEnabled") !== "false";
ttsHighlightCheckbox.checked = ttsHighlightEnabled;
ttsHighlightCheckbox.addEventListener("change", function() {
    ttsHighlightEnabled = ttsHighlightCheckbox.checked;
    localStorage.setItem("ttsHighlightEnabled", ttsHighlightEnabled);
    if (!readerScreen.hidden) displayPage();
});

// Japanese particle colouring: off until the user switches it on.
// The finder itself (highlightJapanese) is just below.
const japaneseHighlightCheckbox = document.getElementById("japanese-highlight");
let japaneseHighlightEnabled = localStorage.getItem("japaneseHighlight") === "true";
japaneseHighlightCheckbox.checked = japaneseHighlightEnabled;
japaneseHighlightCheckbox.addEventListener("change", function() {
    japaneseHighlightEnabled = japaneseHighlightCheckbox.checked;
    localStorage.setItem("japaneseHighlight", japaneseHighlightEnabled);
    if (!readerScreen.hidden) displayPage();
});

// ── Japanese particle colouring ───────────────────────────────────
// When the switch in Settings is on, Japanese text is shown with は, が and を
// coloured (amber, blue, green) and, only in cells that hold more than one
// sentence, the sentence-end marks (。！？) in yellow. This changes how the
// text LOOKS only: the text that is spoken is never touched.
//
// Written as: the finder looks at one cell of text and returns it as HTML
// with small coloured tags around the characters to colour.
//
// Words that only look as if they contain a particle (は, が). Kept in
// plain hiragana. Add more here whenever you meet one that gets coloured
// wrongly. Words that START with は are only matched at the start of a cell
// or after punctuation or a space, because otherwise a real は in front of
// the next word would be hidden (私はこの本 would match はこ).
const JA_NOT_PARTICLE_WORDS = [
    // が inside a word
    "かがみ", "ちがう", "ちがい", "ひがし", "がっこう", "がんばる", "すがた",
    "まがる", "さがす", "かがく", "けんがく", "がめん", "おがむ", "とがめる",
    "ひらがな",
    // words starting with は, or containing は
    "はがき", "はこ", "はし", "はな", "はる", "はち", "はやい", "はじめる",
    "はかる", "はたらく", "はさみ", "おはよう", "はは", "はば"
];

// Characters after which a new word can start (for the は words above).
const JA_WORD_START_CHARS = "、。，．！？!?「『（(【［〔〈《・…―—";

// Sentence-end marks, and the closing quotes/brackets that may follow them.
const JA_END_MARKS = "。．！？!?";
const JA_CLOSERS = "」』）)】］〕〉》”’\"'";

// A が followed by one of these endings is the end of a verb or adjective
// (上がる, 広がります, 怖がらない, ほしがって), not a particle.
const JA_GA_VERB_ENDING = /^(る|っ|りま|りた|り$|り[、。，,\s]|らな|られ|らせ|れば|れる|れた|ろう)/;

function highlightJapanese(text) {
    const n = text.length;
    const hidden = new Array(n).fill(false);      // characters that must stay white

    // 1. Mark the characters of the "not a particle" words.
    JA_NOT_PARTICLE_WORDS.forEach(function(word) {
        const startsWithHa = word.charAt(0) === "は";
        let at = text.indexOf(word);
        while (at !== -1) {
            const before = at === 0 ? "" : text.charAt(at - 1);
            const startsAWord = at === 0 || JA_WORD_START_CHARS.includes(before) || /\s/.test(before);
            if (!startsWithHa || startsAWord) {
                for (let k = 0; k < word.length; k++) hidden[at + k] = true;
            }
            at = text.indexOf(word, at + 1);
        }
    });

    // 2. Sentence ends. Only coloured when something follows the first mark,
    //    meaning the cell holds more than one sentence.
    const endMark = new Array(n).fill(false);
    const groups = [];
    let moreThanOne = false;
    let i = 0;
    while (i < n) {
        if (JA_END_MARKS.includes(text.charAt(i))) {
            let j = i;
            while (j < n && JA_END_MARKS.includes(text.charAt(j))) j++;     // ！？ together
            let k = j;
            while (k < n && JA_CLOSERS.includes(text.charAt(k))) k++;       // skip 」 etc.
            if (/\S/.test(text.slice(k))) moreThanOne = true;
            groups.push([i, j]);
            i = j;
        } else {
            i++;
        }
    }
    if (moreThanOne) {
        groups.forEach(function(g) {
            for (let m = g[0]; m < g[1]; m++) endMark[m] = true;
        });
    }

    // 3. Go through the text, wrapping what should be coloured.
    let html = "";
    for (let p = 0; p < n; p++) {
        const ch = text.charAt(p);
        let cls = "";
        if (endMark[p]) {
            cls = "hl-end";
        } else if (!hidden[p]) {
            if (ch === "を") {
                cls = "hl-wo";
            } else if (ch === "は") {
                if (text.charAt(p - 1) !== "に") cls = "hl-ha";      // には stays white
            } else if (ch === "が") {
                const next = text.charAt(p + 1);
                const commaAfter = next === "、" || next === "，" || next === ",";   // が、 stays white
                if (!commaAfter && !JA_GA_VERB_ENDING.test(text.slice(p + 1))) cls = "hl-ga";
            }
        }
        html += cls ? '<span class="' + cls + '">' + escapeHtml(ch) + "</span>" : escapeHtml(ch);
    }
    return html;
}


// Third view: Russian in italics. Off until the user switches it on.
// For lessons whose second language (L2) is Russian, the third view shows a
// copy of the Russian text in italics, in place of the third spreadsheet
// column (which is ignored while this is on). Other languages are not affected.
const russianItalicsCheckbox = document.getElementById("russian-italics");
let russianItalicsEnabled = localStorage.getItem("russianItalics") === "true";
russianItalicsCheckbox.checked = russianItalicsEnabled;
russianItalicsCheckbox.addEventListener("change", function() {
    russianItalicsEnabled = russianItalicsCheckbox.checked;
    localStorage.setItem("russianItalics", russianItalicsEnabled);
    if (!readerScreen.hidden) displayPage();
});

// Colour Russian letters: off until the user switches it on. The switch opens
// a small list where each group can be turned on or off. All groups start on.
// The colouring function itself (highlightRussian) is just below.
const russianColourCheckbox = document.getElementById("russian-colour");
const russianColourOptions = document.getElementById("russian-colour-options");
const russianFriendsCheckbox = document.getElementById("russian-colour-friends");
const russianFalseCheckbox = document.getElementById("russian-colour-false");
const russianShiftingCheckbox = document.getElementById("russian-colour-shifting");
const russianSignsCheckbox = document.getElementById("russian-colour-signs");
const russianESelect = document.getElementById("russian-colour-e");
function savedRussianFlag(key, fallback) {
    const saved = localStorage.getItem(key);
    return saved === null ? fallback : saved === "true";
}
let russianColourEnabled = savedRussianFlag("russianColour", false);
let russianColourFriends = savedRussianFlag("russianColourFriends", true);
let russianColourFalse = savedRussianFlag("russianColourFalse", true);
let russianColourShifting = savedRussianFlag("russianColourShifting", true);
let russianColourSigns = savedRussianFlag("russianColourSigns", true);
// Е starts in the "shifting vowels" group. (An earlier build saved Е as a friend
// under the key "russianColourE"; that old copy is dropped so everyone starts
// from the new default. The user can still move Е with the dropdown.)
localStorage.removeItem("russianColourE");
let russianColourE = ["friend", "false", "shifting", "none"].includes(localStorage.getItem("russianColourEGroup"))
    ? localStorage.getItem("russianColourEGroup") : "shifting";
russianColourCheckbox.checked = russianColourEnabled;
russianColourOptions.hidden = !russianColourEnabled;
russianFriendsCheckbox.checked = russianColourFriends;
russianFalseCheckbox.checked = russianColourFalse;
russianShiftingCheckbox.checked = russianColourShifting;
russianSignsCheckbox.checked = russianColourSigns;
russianESelect.value = russianColourE;
function russianColourChanged() {
    russianColourEnabled = russianColourCheckbox.checked;
    russianColourFriends = russianFriendsCheckbox.checked;
    russianColourFalse = russianFalseCheckbox.checked;
    russianColourShifting = russianShiftingCheckbox.checked;
    russianColourSigns = russianSignsCheckbox.checked;
    russianColourE = russianESelect.value;
    localStorage.setItem("russianColour", russianColourEnabled);
    localStorage.setItem("russianColourFriends", russianColourFriends);
    localStorage.setItem("russianColourFalse", russianColourFalse);
    localStorage.setItem("russianColourShifting", russianColourShifting);
    localStorage.setItem("russianColourSigns", russianColourSigns);
    localStorage.setItem("russianColourEGroup", russianColourE);
    russianColourOptions.hidden = !russianColourEnabled;
    if (!readerScreen.hidden) displayPage();
}
[russianColourCheckbox, russianFriendsCheckbox, russianFalseCheckbox, russianShiftingCheckbox, russianSignsCheckbox, russianESelect]
    .forEach(function(control) { control.addEventListener("change", russianColourChanged); });

// ── Russian letter colouring ──────────────────────────────────────
// When "Colour Russian letters" is on in Settings, Russian text is shown with
// the letters that look like English ones picked out by colour:
//   friends        look AND sound like English  (green)
//   false friends  look like English, sound different (amber)
//   shifting vowels О (and Е if chosen): the sound changes when the vowel
//                  is not stressed, О towards "а" (violet)
//   signs          the hard and soft signs (blue)
// Everything else stays white. This changes how the text LOOKS only; the
// spoken text is never touched. The colours themselves are in style.css.
const RU_FRIENDS = "АКМТакмт";
const RU_FALSE_FRIENDS = "ВНРСУХвнрсух";
const RU_SHIFTING = "Оо";
const RU_SIGNS = "ЪЬъь";
const RU_E = "Ее";                 // goes with whichever group the user picks in Settings

// In the italic third view some lowercase letters change shape and stop
// looking like their English twin (т turns into something like an m).
// Those are left white there.
const RU_CHANGED_IN_ITALICS = "т";

function russianGroup(ch, italicView) {
    if (RU_SIGNS.includes(ch)) return russianColourSigns ? "sg" : "";
    if (italicView && RU_CHANGED_IN_ITALICS.includes(ch)) return "";
    if (RU_FRIENDS.includes(ch)) return russianColourFriends ? "fr" : "";
    if (RU_FALSE_FRIENDS.includes(ch)) return russianColourFalse ? "ff" : "";
    if (RU_SHIFTING.includes(ch)) return russianColourShifting ? "sh" : "";
    if (RU_E.includes(ch)) {
        if (russianColourE === "friend") return russianColourFriends ? "fr" : "";
        if (russianColourE === "false") return russianColourFalse ? "ff" : "";
        if (russianColourE === "shifting") return russianColourShifting ? "sh" : "";
    }
    return "";
}

function highlightRussian(text, italicView) {
    let html = "";
    let run = "";
    let runClass = "";
    function flush() {
        if (!run) return;
        html += runClass ? '<span class="ru-' + runClass + '">' + escapeHtml(run) + "</span>" : escapeHtml(run);
        run = "";
    }
    for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        const cls = russianGroup(ch, italicView);
        if (cls !== runClass) { flush(); runClass = cls; }     // same-colour letters share one tag
        run += ch;
    }
    flush();
    return html;
}


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

// Reading pattern: what is spoken for each sentence.
//   normal   = the L2 sentence only (the way the app has always worked)
//   l1-only  = the L1 sentence only (no gap)
//   l1-l2    = L1, a gap for you to say it aloud, then L2
//   l2-l1    = L2, a gap, then L1
//   l2-l1-l2 = L2, a gap, then L1, then L2 again
//   l1-l2-l1 = L1, a gap, then L2, then L1 again
// One setting for the whole app. "Gap length" only matters for the patterns with a gap.
const readingPatternSelect = document.getElementById("reading-pattern");
const gapRow = document.getElementById("gap-row");
const gapSlider = document.getElementById("gap-seconds");
const gapValue = document.getElementById("gap-seconds-value");
const READING_PATTERNS = ["normal", "l1-only", "l1-l2", "l2-l1", "l2-l1-l2", "l1-l2-l1"];
let readingPattern = READING_PATTERNS.includes(localStorage.getItem("readingPattern"))
    ? localStorage.getItem("readingPattern") : "normal";
let gapSeconds = parseFloat(localStorage.getItem("gapSeconds"));
if (isNaN(gapSeconds)) gapSeconds = 3;
gapSeconds = Math.min(8, Math.max(1, gapSeconds));

function showGap(value) {
    gapSeconds = value;
    gapSlider.value = value;
    gapValue.textContent = value.toFixed(1) + " s";
}

function showPatternSettings() {
    readingPatternSelect.value = readingPattern;
    gapRow.hidden = (readingPattern === "normal" || readingPattern === "l1-only");   // no gap in these two
}

showGap(gapSeconds);
showPatternSettings();

readingPatternSelect.addEventListener("change", function() {
    readingPattern = READING_PATTERNS.includes(readingPatternSelect.value)
        ? readingPatternSelect.value : "normal";
    localStorage.setItem("readingPattern", readingPattern);
    showPatternSettings();
});

gapSlider.addEventListener("input", function() {
    showGap(parseFloat(gapSlider.value));
    localStorage.setItem("gapSeconds", gapSeconds);
});

// Pause between sentences: extra waiting time after each sentence, in every
// mode (Normal too). 0 means none, which keeps Normal exactly as it was.
// For quizzes: question, pause, answer.
const pauseSlider = document.getElementById("sentence-pause");
const pauseValue = document.getElementById("sentence-pause-value");
let sentencePauseSeconds = parseFloat(localStorage.getItem("sentencePause"));
if (isNaN(sentencePauseSeconds)) sentencePauseSeconds = 0;
sentencePauseSeconds = Math.min(10, Math.max(0, sentencePauseSeconds));

function showSentencePause(value) {
    sentencePauseSeconds = value;
    pauseSlider.value = value;
    pauseValue.textContent = value.toFixed(1) + " s";
}

showSentencePause(sentencePauseSeconds);

pauseSlider.addEventListener("input", function() {
    showSentencePause(parseFloat(pauseSlider.value));
    localStorage.setItem("sentencePause", sentencePauseSeconds);
});


// ═══════════════════════════════════════════════════════════════
//  EARBUD / HEADSET BUTTONS
// ═══════════════════════════════════════════════════════════════
// Phones only send earbud button presses to an app they think is a media
// player, and they do not count text-to-speech as media. So while a lesson
// is open (and the switch is on) we loop an inaudible 10-second sound and
// tell the phone "I am a media player" through the Media Session API.
// Earbud presses then arrive as play / pause / next / previous.

const earbudCheckbox = document.getElementById("earbud-buttons");
const earbudSkipSelect = document.getElementById("earbud-skip-unit");
let earbudButtons = localStorage.getItem("earbudButtons") === "true";          // off until the user switches it on
let earbudSkipUnit = localStorage.getItem("earbudSkipUnit") === "page" ? "page" : "sentence";
earbudCheckbox.checked = earbudButtons;
earbudSkipSelect.value = earbudSkipUnit;

// Earbud log lines carry a seconds stamp so gaps between presses are visible
function earbudLog(message) {
    ttsLog((Math.floor(performance.now() / 1000) % 1000) + "s " + message);
}
document.addEventListener("visibilitychange", function() {
    if (earbudButtons) earbudLog("earbud: page " + document.visibilityState);
});

// EXPERIMENT (build d). true  = the quiet sound plays only while reading, like a
// normal music player (so the phone's "playing / paused" matches what you hear).
// false = it plays the whole time a lesson is open (the earlier behaviour).
const EARBUD_SOUND_ONLY_WHILE_READING = true;

let earbudAudio = null;            // the silent looping sound (made the first time it is needed)
let earbudAudioWanted = false;     // true while we want it playing
let earbudHandlersSet = false;
const hasMediaSession = "mediaSession" in navigator;

// Builds 10 seconds of silence as a tiny sound file in memory, so there is
// no extra file to download or keep for offline use.
function makeSilentSoundUrl() {
    const rate = 8000;
    const count = rate * 10;
    const buffer = new ArrayBuffer(44 + count);
    const view = new DataView(buffer);
    const text = function(offset, s) {
        for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    text(0, "RIFF");  view.setUint32(4, 36 + count, true);
    text(8, "WAVE");  text(12, "fmt ");
    view.setUint32(16, 16, true);   view.setUint16(20, 1, true);   // plain sound data
    view.setUint16(22, 1, true);                                   // one channel
    view.setUint32(24, rate, true); view.setUint32(28, rate, true);
    view.setUint16(32, 1, true);    view.setUint16(34, 8, true);   // 8-bit
    text(36, "data"); view.setUint32(40, count, true);
    new Uint8Array(buffer, 44).fill(128);                          // 128 = silence
    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

function ensureEarbudAudio() {
    if (earbudAudio) return earbudAudio;
    earbudAudio = new Audio(makeSilentSoundUrl());
    earbudAudio.loop = true;
    earbudAudio.addEventListener("play", function() { earbudLog("earbud: quiet sound started"); });
    // If the phone pauses the sound on its own (another app took over, for
    // example), try once to start it again so the buttons keep working.
    earbudAudio.addEventListener("pause", function() {
        earbudLog("earbud: quiet sound paused, wanted=" + earbudAudioWanted);
        if (!earbudAudioWanted) return;
        setTimeout(function() {
            if (earbudAudioWanted && earbudAudio.paused) {
                earbudAudio.play().catch(function(e) { ttsLog("earbud: restart failed " + e); });
            }
        }, 500);
    });
    return earbudAudio;
}

// How earbud presses move through the lesson
function earbudSkip(direction) {
    const wasPlaying = isSpeaking && !ttsStopped;
    if (earbudSkipUnit === "page") {
        if (direction > 0) goToNextPage(); else goToPreviousPage();
        // Pressing a button while listening should keep the listening going
        if (wasPlaying && !isSpeaking && pages[currentPage] && !pages[currentPage].isEnd) startTts();
    } else {
        moveToSentence(direction);
    }
}

// One earbud press arrives as "play" or "pause" depending on what the phone
// believes is happening. Because the quiet sound is always playing, the phone
// may send "pause" even when reading is stopped. So both act as a toggle,
// based on what the app itself knows: reading -> stop, stopped -> start.
let lastEarbudToggleAt = 0;
function earbudToggle() {
    const now = performance.now();
    if (now - lastEarbudToggleAt < 500) {
        earbudLog("earbud: ignored a repeat press");
        return;
    }
    lastEarbudToggleAt = now;
    ttsButton.click();           // the on-screen Play/Stop button already does exactly this
}

// Turns the quiet sound on or off (never when earbud buttons are off / no lesson is open)
function earbudSetSound(on) {
    if (!earbudButtons || !currentLessonId) return;
    earbudAudioWanted = on;
    const sound = ensureEarbudAudio();
    if (on) {
        sound.play().catch(function(e) { earbudLog("earbud: quiet sound blocked " + e); });
    } else if (!sound.paused) {
        sound.pause();
    }
}

function setMediaAction(name, action) {
    try {
        navigator.mediaSession.setActionHandler(name, action ? function() {
            earbudLog("earbud: " + name + " (reading=" + (isSpeaking && !ttsStopped) +
                      ", sound=" + (earbudAudio && !earbudAudio.paused ? "on" : "off") + ")");
            if (!earbudButtons || !currentLessonId) return;
            action();
        } : null);
    } catch (e) {
        ttsLog("earbud: " + name + " not supported here");
    }
}

function setEarbudHandlers(on) {
    if (!hasMediaSession || earbudHandlersSet === on) return;
    earbudHandlersSet = on;
    setMediaAction("play", on ? earbudToggle : null);
    setMediaAction("pause", on ? earbudToggle : null);
    setMediaAction("nexttrack", on ? function() { earbudSkip(1); } : null);
    setMediaAction("previoustrack", on ? function() { earbudSkip(-1); } : null);
}

// Called by setTtsButtonState: keep the phone's idea of playing / paused correct
function earbudShowState(state) {
    if (!hasMediaSession || !earbudButtons || !currentLessonId) return;
    navigator.mediaSession.playbackState = (state === "stop") ? "playing" : "paused";
    if (EARBUD_SOUND_ONLY_WHILE_READING) earbudSetSound(state === "stop");
}

function earbudStart() {
    if (!earbudButtons || !currentLessonId || !hasMediaSession) return;
    setEarbudHandlers(true);
    earbudSetSound(EARBUD_SOUND_ONLY_WHILE_READING ? (isSpeaking && !ttsStopped) : true);
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: (library.find(l => l.id === currentLessonId) || {}).title || "SwitchReader",
            artist: "SwitchReader",
            album: currentBook ? currentBook.l2Name : "",
            artwork: [{ src: "web-app-manifest-512x512.png", sizes: "512x512", type: "image/png" }]
        });
    } catch (e) {}
    navigator.mediaSession.playbackState = (isSpeaking && !ttsStopped) ? "playing" : "paused";
}

function earbudStop() {
    earbudAudioWanted = false;
    if (earbudAudio && !earbudAudio.paused) earbudAudio.pause();
    if (hasMediaSession) {
        try { navigator.mediaSession.metadata = null; } catch (e) {}
        navigator.mediaSession.playbackState = "none";
    }
}

earbudCheckbox.addEventListener("change", function() {
    earbudButtons = earbudCheckbox.checked;
    localStorage.setItem("earbudButtons", earbudButtons);
    if (earbudButtons) {
        if (!hasMediaSession) ttsLog("earbud: this browser has no media session");
        earbudStart();            // this tap counts as the "user gesture" the phone wants
    } else {
        earbudStop();
        setEarbudHandlers(false);
    }
});

earbudSkipSelect.addEventListener("change", function() {
    earbudSkipUnit = earbudSkipSelect.value === "page" ? "page" : "sentence";
    localStorage.setItem("earbudSkipUnit", earbudSkipUnit);
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
//  RESET TO DEFAULTS
// ═══════════════════════════════════════════════════════════════
// Puts every setting back to how it was on first install. It never touches
// lessons, reading positions or the home-screen language filter.

document.getElementById("reset-settings-button").addEventListener("click", function() {
    if (!confirm("Put all settings back to their defaults?\n\n" +
                 "Your lessons and reading positions are not affected.")) return;

    const setSlider = function(slider, value) {
        slider.value = value;
        slider.dispatchEvent(new Event("input"));
    };
    const setSwitch = function(box, on) {
        box.checked = on;
        box.dispatchEvent(new Event("change"));
    };

    setSwitch(perLanguageCheckbox, false);   // first, so the sliders below reset the shared set
    setSlider(ttsSpeedSlider, "1.0");
    setSlider(fontSizeSlider, "22");
    setSlider(lineSpacingSlider, "150");
    setSwitch(ttsHighlightCheckbox, true);
    setSwitch(japaneseHighlightCheckbox, false);
    setSwitch(russianItalicsCheckbox, false);
    setSwitch(russianColourCheckbox, false);
    setSwitch(russianFriendsCheckbox, true);
    setSwitch(russianFalseCheckbox, true);
    setSwitch(russianShiftingCheckbox, true);
    setSwitch(russianSignsCheckbox, true);
    russianESelect.value = "shifting";
    russianESelect.dispatchEvent(new Event("change"));
    setSwitch(tapStartsTtsCheckbox, false);
    setSwitch(continueTtsOnPageTurnCheckbox, false);
    setSwitch(autoNextLessonCheckbox, false);
    setSwitch(nextSameLanguageCheckbox, true);
    setSwitch(thirdModeCheckbox, true);
    setSwitch(followTogetherCheckbox, true);
    readingPatternSelect.value = "normal";
    readingPatternSelect.dispatchEvent(new Event("change"));
    setSlider(gapSlider, "3");
    setSlider(pauseSlider, "0");
    setSwitch(document.getElementById("show-debug-log"), false);
    setSwitch(earbudCheckbox, false);
    earbudSkipSelect.value = "sentence";
    earbudSkipSelect.dispatchEvent(new Event("change"));

    // Voices: back to Automatic for every language
    selectedTtsVoiceURI = "";
    ttsVoiceSelect.value = "";

    // The controls above saved their default values as they changed.
    // Forget those saved copies so the app starts from its built-in defaults.
    [
        "switchreader-font-size", "switchreader-line-spacing", "ttsSpeed",
        "ttsHighlightEnabled", "tapStartsTts", "continueTtsOnPageTurn",
        "autoNextLesson", "nextSameLanguage", "thirdModeEnabled",
        "blankModeEnabled", "followTogether", "showDebugLog",
        "perLanguageSettings", LANG_SETTINGS_KEY,
        "earbudButtons", "earbudSkipUnit",
        "readingPattern", "gapSeconds", "sentencePause",
        "japaneseHighlight", "russianItalics", "russianColour",
        "russianColourFriends", "russianColourFalse", "russianColourShifting", "russianColourSigns",
        "russianColourE", "russianColourEGroup"
    ].forEach(function(key) { localStorage.removeItem(key); });
    Object.keys(localStorage)
        .filter(function(key) { return key.startsWith("ttsVoiceURI_"); })
        .forEach(function(key) { localStorage.removeItem(key); });
});

// ═══════════════════════════════════════════════════════════════
//  SCREEN SWITCHING
// ═══════════════════════════════════════════════════════════════

function showHomeScreen() {
    readerScreen.hidden = true;
    homeScreen.hidden = false;
    document.body.classList.add("on-home");
    applyLanguageSettings(false);
    updateSettingsAvailability();
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

// { state: "new" | "reading" | "done", current, total, percent, at, finishedBefore }
// "done" means finished and still sitting at the end. A lesson finished earlier
// that you are now reading again is "reading", with finishedBefore = true.
function lessonStatus(lesson) {
    const total = Math.max(1, totalSentences(lesson));
    const position = readLessonPosition(lesson.id);
    if (!position || typeof position.sentence !== "number") {
        return { state: "new", current: 0, total: total, percent: 0, at: 0 };
    }
    const finishedBefore = position.finished === true;
    const done = finishedBefore && Math.floor(position.sentence) >= total - 1;
    const current = done ? total : Math.min(total, Math.floor(position.sentence) + 1);
    return {
        state: done ? "done" : "reading",
        current: current,
        total: total,
        percent: Math.round(current * 100 / total),
        at: position.at || 0,
        finishedBefore: finishedBefore
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
        const finishedMark = status.finishedBefore
            ? '<span class="done-tag" title="Finished before" aria-label="Finished before"><svg width="14" height="14"><use href="#i-check"/></svg></span>'
            : '';
        progress = '<span class="progress-track"><span class="progress-fill" style="width:' + status.percent + '%"></span></span>' +
            '<span class="progress-text">' + finishedMark + '<span><b>' + status.current + '</b> / ' + status.total +
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
    applyLanguageSettings(false);        // this language's speed / font / spacing (pagination follows below)
    updateSettingsAvailability();

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
    earbudStart();                       // earbud buttons (does nothing unless switched on)
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
    earbudStop();
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
    // Russian italics: a Russian lesson (L2 is Russian) with the option on.
    const russianItalics = russianItalicsEnabled && !onEnd && /^ru(-|$)/i.test(currentBook?.l2Code || "");
    const thirdHasText = !onEnd && (russianItalics ? page.l2 : (page.l3 || [])).some(Boolean);

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
        : (russianItalics ? page.l2 : (thirdHasText ? page.l3 : []));

    // Tell the browser which language this text is in, so it picks the right
    // letter shapes (this matters most for Japanese) and screen readers
    // pronounce it properly.
    const textLang = onEnd ? ""
                   : displayMode === 1 ? currentBook?.l1Code
                   : displayMode === 2 ? currentBook?.l2Code
                   : (russianItalics ? currentBook?.l2Code : "");
    if (textLang) readingArea.setAttribute("lang", textLang);
    else readingArea.removeAttribute("lang");
    readingArea.classList.toggle("russian-italic", displayMode === 0 && russianItalics);

    // Colour the particles only for Japanese text (not the third mode, which has no language).
    const colourJapanese = japaneseHighlightEnabled && !onEnd && /^ja(-|$)/i.test(textLang || "");

    // Colour the Russian letters only for Russian text. In the italic third view
    // a few letters change shape, so that view is told (italicView).
    const colourRussian = russianColourEnabled && !onEnd && /^ru(-|$)/i.test(textLang || "");
    const italicView = displayMode === 0 && russianItalics;

    readingArea.innerHTML = onEnd ? buildEndCardHtml() : texts.map((sentence, index) => {
        const highlight =
            ttsHighlightEnabled && texts.length > 1 && index === currentSentenceIndex
                ? ' class="tts-current-sentence"'
                : '';
        // In the third mode, an empty cell still keeps its line so the rest stays lined up.
        const shown = (colourJapanese ? highlightJapanese(sentence)
                      : colourRussian ? highlightRussian(sentence, italicView)
                      : escapeHtml(sentence))
            || (displayMode === 0 ? "&nbsp;" : "");
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
    const modeLabels = ["3", l1Short, l2Short];   // 3 = third mode

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
    earbudShowState(state);
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

// What gets spoken for one sentence, as a short list of steps.
// Normal is always just the L2 text. "L1 only" is just the L1 text. A sentence
// with no L1 text is read as L2 only, so there is never a pointless gap (and
// "L1 only" never goes silent).
// In the patterns with a gap, a short built-in pause ends every sentence, so
// the last point has a moment to sink in before the next one starts. The
// "Pause between sentences" slider is added on top of it, in every mode.
const PATTERN_PAUSE_SECONDS = 0.5;

function buildSpeechSteps(page, index) {
    const l2 = { kind: "l2", text: page.l2[index] };
    const l1Text = String((page.l1 || [])[index] ?? "").trim();
    const l1 = { kind: "l1", text: l1Text };

    // "L1 only" has no gap, so it behaves like Normal (no built-in pause).
    const hasGap = (readingPattern !== "normal" && readingPattern !== "l1-only");

    // Waiting time after the sentence. Normal with the slider at 0 has none.
    const pauseSeconds = (hasGap ? PATTERN_PAUSE_SECONDS : 0) + sentencePauseSeconds;
    function withPause(steps) {
        if (pauseSeconds > 0) steps.push({ kind: "gap", seconds: pauseSeconds });
        return steps;
    }

    if (readingPattern === "normal") return withPause([l2]);
    if (readingPattern === "l1-only") return withPause([l1Text ? l1 : l2]);

    // A sentence with no L1 text is read as L2 only, so there is no pointless gap.
    if (!l1Text) return withPause([l2]);

    const gap = { kind: "gap", seconds: gapSeconds };
    const steps = readingPattern === "l1-l2" ? [l1, gap, l2]
                : readingPattern === "l2-l1" ? [l2, gap, l1]
                : readingPattern === "l1-l2-l1" ? [l1, gap, l2, l1]
                : [l2, gap, l1, l2];
    return withPause(steps);
}

function speakNextSentence(attempt = 0, stepIndex = 0) {

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

    // One sentence can be several steps (say L1, wait, say L2 ...).
    // This call does one step, then asks for the next.
    const steps = buildSpeechSteps(pages[currentPage], currentSentenceIndex);
    const step = steps[stepIndex];
    const isLastStep = stepIndex >= steps.length - 1;

    function afterStep() {
        if (isLastStep) {
            currentSentenceIndex++;
            speakNextSentence();
        } else {
            speakNextSentence(0, stepIndex + 1);
        }
    }

    // A gap is just waiting. Stop, a page turn or a new tap all end the
    // session, and the check below then lets the wait fizzle out.
    if (step.kind === "gap") {
        currentUtterance = null;
        ttsLog("gap " + step.seconds + "s");
        setTimeout(function() {
            if (sessionId !== ttsSessionId || ttsStopped || !isSpeaking) return;
            afterStep();
        }, step.seconds * 1000);
        return;
    }

    const utterance = new SpeechSynthesisUtterance(step.text);
    currentUtterance = utterance;
    let started = false;
    let wordEvents = 0;                       // how many "now on word N" reports the voice gave
    const sentenceLength = step.text.length;

    // L1 steps use the L1 language and the phone's automatic voice for it.
    // The voice you picked in Settings belongs to L2 only.
    utterance.lang = currentBook
        ? (step.kind === "l1" ? currentBook.l1Code : currentBook.l2Code)
        : "en-GB";

    if (step.kind === "l2" && selectedTtsVoiceURI) {
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
            speakNextSentence(attempt + 1, stepIndex);
        }, 200);
        return true;
    }

    utterance.onboundary = function(event) {
        if (!isLive()) return;
        if (step.kind !== "l2") return;       // following along only makes sense in L2
        if (event.name && event.name !== "word") return;
        wordEvents++;
        followSpokenPosition(event.charIndex || 0, sentenceLength);
    };

    utterance.onstart = function() {
        if (!isLive()) return;
        started = true;
        ttsLog("start " + step.kind);
    };

    utterance.onend = function() {
        if (!isLive()) return;
        ttsLog("end " + step.kind + ", word events: " + wordEvents);
        afterStep();
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
    ttsLog("speak " + step.kind + " (attempt " + attempt + ")");
    window.speechSynthesis.speak(utterance);

    // THEN update the UI (once per sentence, on its first step)
    if (stepIndex === 0) displayPage();

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
        '<button type="button" class="primary-button" data-end-action="home">Home</button>' +
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
    if (button.dataset.endAction === "home") {
        homeButton.click();                 // the same as the Home button in the top corner
    } else if (button.dataset.endAction === "restart") {
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