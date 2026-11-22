// ═══════════════════════════════════════════════════════════════
//  SWITCHREADER — parallel-text lesson reader
// ═══════════════════════════════════════════════════════════════

const APP_BUILD = "2026-11-22d";   // shown at the bottom of Settings: tells you which build is running

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

// The lesson-wide number of the sentence you are on right now.
function currentGlobalSentence() {
    const page = pages[currentPage];
    if (!page || typeof page.startSentence !== "number") return 0;
    const within = Math.max(0, Math.min(currentSentenceIndex, page.l2.length - 1));
    return page.startSentence + within;
}

// Turn a lesson-wide sentence number back into a page and a sentence on it,
// using the pages as they are laid out right now.
function locateGlobalSentence(globalSentence) {
    if (pages.length === 0) return { page: 0, sentence: 0 };
    let pageIndex = 0;
    for (let i = 0; i < pages.length; i++) {
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
    if (old && pages.length > 0) {
        const pageIndex = Math.max(0, Math.min(old.page || 0, pages.length - 1));
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
        localStorage.setItem(positionKey(currentLessonId), JSON.stringify({
            v: 2,
            sentence: currentGlobalSentence(),
            mode: displayMode
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

// Blank mode
const blankModeCheckbox = document.getElementById("blank-mode-enabled");
let blankModeEnabled = localStorage.getItem("blankModeEnabled") !== "false";
blankModeCheckbox.checked = blankModeEnabled;
blankModeCheckbox.addEventListener("change", function() {
    blankModeEnabled = blankModeCheckbox.checked;
    localStorage.setItem("blankModeEnabled", blankModeEnabled);
    if (!blankModeEnabled && displayMode === 0) displayMode = 1;
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
    renderLibrary();
}

function showReaderScreen() {
    homeScreen.hidden = true;
    readerScreen.hidden = false;
}

// ═══════════════════════════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════════════════════════

function closeAllModals() {
    settingsPanel.hidden = true;
    importPanel.hidden = true;
}

function toggleSettings() {
    // If it's already open, close it. Otherwise, open it and close import.
    if (!settingsPanel.hidden) {
        settingsPanel.hidden = true;
    } else {
        settingsPanel.hidden = false;
        importPanel.hidden = true;
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

function renderLibrary() {
    libraryList.innerHTML = "";

    if (library.length === 0) {
        libraryList.innerHTML =
            '<p class="empty-state">No lessons yet.<br>Tap "Add lesson" to import one.</p>';
        return;
    }

    const sorted = library.slice().sort((a, b) =>
        (b.createdAt || 0) - (a.createdAt || 0)
    );

    sorted.forEach(lesson => {
        const row = document.createElement("div");
        row.className = "lesson-row";

        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "lesson-open";

        const l2Short = (lesson.l2Code || "").split("-")[0].toUpperCase();
        const l1Short = (lesson.l1Code || "").split("-")[0].toUpperCase();
        const count = lesson.units.reduce(
            (sum, u) => sum + (Array.isArray(u.l2) ? u.l2.length : 1), 0
        );

        openBtn.innerHTML =
            '<div class="lesson-title">' + escapeHtml(lesson.title) + '</div>' +
            '<div class="lesson-meta">' + l2Short + ' → ' + l1Short +
            ' · ' + count + ' sentence' + (count === 1 ? "" : "s") + '</div>';

        openBtn.addEventListener("click", () => openLesson(lesson.id));

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "lesson-delete";
        deleteBtn.title = "Delete";
        deleteBtn.innerHTML =
            '<svg width="18" height="18"><use href="#i-trash"/></svg>';
        deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteLesson(lesson.id);
        });

        row.appendChild(openBtn);
        row.appendChild(deleteBtn);
        libraryList.appendChild(row);
    });
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

function openLesson(lessonId) {
    const lesson = library.find(l => l.id === lessonId);
    if (!lesson) return;

    saveCurrentPosition();

    history.pushState({ view: 'reader' }, '', '#reader');

    currentLessonId = lessonId;
    currentBook = {
        l2Code: lesson.l2Code,
        l2Name: lesson.l2Name,
        l1Code: lesson.l1Code,
        l1Name: lesson.l1Name
    };

    readingUnits = lesson.units.map(u => ({
        l2: Array.isArray(u.l2) ? u.l2 : [u.l2 || ""],
        l1: Array.isArray(u.l1) ? u.l1 : [u.l1 || ""]
    }));

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
    const place = locateGlobalSentence(saved.sentence);
    currentPage = place.page;
    currentSentenceIndex = place.sentence;

    let restoredMode = saved.mode;
    if (restoredMode === 0 && !blankModeEnabled) restoredMode = 2;
    displayMode = restoredMode;

    displayPage();
}

function goHome() {
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
        alert("The spreadsheet reader could not be loaded. It needs an " +
              "internet connection. Please connect and reload the app, " +
              "then try again.");
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

        importPanel.hidden = true;
        renderLibrary();
    } catch (error) {
        alert("There was a problem reading this file. Please check that " +
              "it is an Excel or CSV file with the original language in " +
              "column A and the translation in column B.");
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

    let startRow = 0;
    if (rows.length > 0) {
        const firstColumn = normaliseHeading(rows[0][0]);
        const secondColumn = normaliseHeading(rows[0][1]);
        if (l2Headings.includes(firstColumn) && l1Headings.includes(secondColumn)) {
            startRow = 1;
        }
    }

    return rows.slice(startRow)
        .map(row => ({
            l2: [String(row[0] ?? "").trim()],
            l1: [String(row[1] ?? "").trim()]
        }))
        .filter(unit => unit.l2[0] !== "" || unit.l1[0] !== "");
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

    if (availableHeight <= 0 || !availableWidth) {
        // Can't measure right now: fall back to one unit per page.
        let counter = 0;
        pages = readingUnits.map(function(unit, index) {
            const l2 = Array.isArray(unit.l2) ? unit.l2 : [unit.l2 || ""];
            const l1 = Array.isArray(unit.l1) ? unit.l1 : [unit.l1 || ""];
            const page = { l2: l2.slice(), l1: l1.slice(),
                           startUnitIndex: index, endUnitIndex: index,
                           startSentence: counter };
            counter += l2.length;
            return page;
        });
        lastPaginatedWidth = 0;
        lastPaginatedHeight = 0;
        const fallbackPlace = locateGlobalSentence(anchorSentence);
        currentPage = fallbackPlace.page;
        currentSentenceIndex = fallbackPlace.sentence;
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

    function measureTexts(texts) {
        let totalHeight = 0;
        texts.forEach(function(text) {
            const paragraph = document.createElement("p");
            paragraph.textContent = text;
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
    let sentenceCounter = 0;   // L2 sentences seen so far, across the whole lesson

    function finishPage(endIndex) {
        if (!currentPageData) return;
        currentPageData.endUnitIndex = endIndex;
        newPages.push(currentPageData);
    }

    readingUnits.forEach(function(unit, index) {
        const l2Texts = Array.isArray(unit.l2) ? unit.l2 : [unit.l2 || ""];
        const l1Texts = Array.isArray(unit.l1) ? unit.l1 : [unit.l1 || ""];

        const newL2Height = measureTexts(l2Texts);
        const newL1Height = measureTexts(l1Texts);

        const wouldOverflow =
            Math.max(l2Height + newL2Height, l1Height + newL1Height) > availableHeight;

        if (wouldOverflow && currentPageData) {
            finishPage(index - 1);
            currentPageData = null;
            l2Height = 0;
            l1Height = 0;
        }

        if (!currentPageData) {
            currentPageData = {
                l2: [], l1: [],
                startUnitIndex: index,
                startSentence: sentenceCounter
            };
        }

        currentPageData.l2.push(...l2Texts);
        currentPageData.l1.push(...l1Texts);
        l2Height += newL2Height;
        l1Height += newL1Height;
        sentenceCounter += l2Texts.length;
    });

    finishPage(readingUnits.length - 1);
    measureBox.remove();

    pages = newPages;
    lastPaginatedWidth = readingArea.clientWidth;
    lastPaginatedHeight = readingArea.clientHeight;

    // Put you back on the same sentence, wherever it landed in the new pages.
    const place = locateGlobalSentence(anchorSentence);
    currentPage = place.page;
    currentSentenceIndex = place.sentence;
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
    if (modeSwitched && lastRenderMode !== 0) {
        // Leaving a language: remember where we were in it, before it is redrawn.
        scrollByMode[lastRenderMode] = previousScrollTop;
        heldReadingPoint = captureReadingPoint(previousScrollTop);
    }

    readingArea.innerHTML = "";

    const texts = displayMode === 1
        ? pages[currentPage].l1
        : displayMode === 2
            ? pages[currentPage].l2
            : [];

    readingArea.innerHTML = texts.map((sentence, index) => {
        const highlight =
            ttsHighlightEnabled && index === currentSentenceIndex
                ? ' class="tts-current-sentence"'
                : '';
        return `<p${highlight}>${escapeHtml(sentence)}</p>`;
    }).join("");

    if (sameView) {
        readingArea.scrollTop = previousScrollTop;
    } else if (modeSwitched) {
        if (displayMode !== 0) {
            if (followTogether) applyReadingPoint(heldReadingPoint);
            else readingArea.scrollTop = scrollByMode[displayMode] || 0;
        }
    } else {
        readingArea.scrollTop = 0;              // a different page starts at the top
    }
    if (!sameView) {
        clearTimeout(pendingScrollTimer);
        pendingScrollTarget = null;
    }
    if (displayMode !== 0 && (!samePage || sentenceMoved)) {
        keepCurrentSentenceInView(samePage);    // glide if still on the same page
    }
    lastPageKey = pageKey;
    lastRenderMode = displayMode;
    lastRenderSentence = currentSentenceIndex;
    updateScrollButtons();

    const l1Short = (currentBook?.l1Code || "").split("-")[0].toUpperCase();
    const l2Short = (currentBook?.l2Code || "").split("-")[0].toUpperCase();
    const modeLabels = ["—", l1Short, l2Short];

    modeLabel.textContent = modeLabels[displayMode] || "";
    modeLabel.classList.toggle("blank", displayMode === 0);

    pageNumber.textContent = `${currentPage + 1} / ${pages.length}`;

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
    if (displayMode === 0 || textLength <= 0) return;
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

function cycleDisplayMode(direction) {
    if (blankModeEnabled) {
        displayMode = (displayMode + (direction === -1 ? 2 : 1)) % 3;
    } else {
        displayMode = displayMode === 1 ? 2 : 1;
    }
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
    } else if (state === "continue") {
        ttsIcon.setAttribute("href", "#i-play");
        ttsButton.setAttribute("title", "Continue");
    } else {
        ttsIcon.setAttribute("href", "#i-play");
        ttsButton.setAttribute("title", "Play");
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
        if (currentPage < pages.length - 1) {
            currentPage++;
            currentSentenceIndex = 0;
            ttsPage = currentPage;
            displayPage();
            speakNextSentence();
            return;
        }

        currentSentenceIndex = sentences.length - 1;
        isSpeaking = false;
        ttsStopped = false;
        currentUtterance = null;
        setTtsButtonState("play");
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
    if (displayMode !== 0) displayPage();

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

    if (wasPlaying && continueTtsOnPageTurn) {
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
        if (currentPage < pages.length - 1) {
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
    }

    if (readerScreen.hidden) return;
    if (!settingsPanel.hidden) return;
    if (!importPanel.hidden) return;

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
})();

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