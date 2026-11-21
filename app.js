// ═══════════════════════════════════════════════════════════════
//  SWITCHREADER — parallel-text lesson reader
// ═══════════════════════════════════════════════════════════════

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
    localStorage.setItem("switchreader-library", JSON.stringify(library));
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

function saveCurrentPosition() {
    if (!currentLessonId) return;
    const lesson = library.find(l => l.id === currentLessonId);
    if (!lesson) return;
    lesson.position = {
        page: currentPage,
        sentence: currentSentenceIndex,
        mode: displayMode
    };
    saveLibrary();
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

// Font size
const savedFontSize = localStorage.getItem("switchreader-font-size");
if (savedFontSize !== null) fontSizeSlider.value = savedFontSize;

fontSizeSlider.addEventListener("input", function() {
    const size = fontSizeSlider.value;
    readingArea.style.fontSize = size + "px";
    fontSizeValue.textContent = size + "px";
    localStorage.setItem("switchreader-font-size", size);
    
    if (!readerScreen.hidden) {
        paginateReadingUnits();
        displayPage();
    }
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

    if (!readerScreen.hidden) {
        paginateReadingUnits();
        displayPage();
    }
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

    currentPage = 0;
    currentSentenceIndex = 0;
    displayMode = 2;

    // Make reader visible first — pagination needs real clientHeight
    showReaderScreen();

    populateTtsVoices();
    paginateReadingUnits();

    // Restore saved position
    const pos = lesson.position || { page: 0, sentence: 0, mode: 2 };
    currentPage = Math.max(0, Math.min(pos.page || 0, pages.length - 1));
    currentSentenceIndex = Math.max(0,
        Math.min(pos.sentence || 0, (pages[currentPage]?.l2.length || 1) - 1));

    let restoredMode = (typeof pos.mode === "number") ? pos.mode : 2;
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
        saveLibrary();

        importPanel.hidden = true;
        renderLibrary();
    } catch (error) {
        alert("There was a problem importing this file. " +
              "Please check that it is a valid Excel workbook.");
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

    if (!availableHeight || !availableWidth) {
        pages = readingUnits;
        return;
    }

    const currentStart = pages[currentPage]?.startUnitIndex ?? 0;
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
                startUnitIndex: index
            };
        }

        currentPageData.l2.push(...l2Texts);
        currentPageData.l1.push(...l1Texts);
        l2Height += newL2Height;
        l1Height += newL1Height;
    });

    finishPage(readingUnits.length - 1);
    measureBox.remove();

    pages = newPages;

    currentPage = pages.findIndex(function(page) {
        return currentStart >= page.startUnitIndex &&
               currentStart <= page.endUnitIndex;
    });

    if (currentPage === -1) currentPage = 0;
}

// ═══════════════════════════════════════════════════════════════
//  DISPLAY
// ═══════════════════════════════════════════════════════════════

function displayPage() {

    if (!pages[currentPage]) {
        readingArea.innerHTML = "";
        pageNumber.textContent = "0 / 0";
        return;
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

    const l1Short = (currentBook?.l1Code || "").split("-")[0].toUpperCase();
    const l2Short = (currentBook?.l2Code || "").split("-")[0].toUpperCase();
    const modeLabels = ["—", l1Short, l2Short];

    modeLabel.textContent = modeLabels[displayMode] || "";
    modeLabel.classList.toggle("blank", displayMode === 0);

    pageNumber.textContent = `${currentPage + 1} / ${pages.length}`;

    saveCurrentPositionSoon();
}

// ═══════════════════════════════════════════════════════════════
//  NAVIGATION HELPERS
// ═══════════════════════════════════════════════════════════════

function changePageWithTts(changeFn) {
    const wasSpeaking = isSpeaking && !ttsStopped;

    if (wasSpeaking || ttsStopped) window.speechSynthesis.cancel();

    ttsSessionId++;
    changeFn();
    currentSentenceIndex = 0;
    ttsPage = currentPage;
    currentUtterance = null;

    displayPage();

    if (wasSpeaking && continueTtsOnPageTurn) {
        isSpeaking = true;
        ttsStopped = false;
        setTtsButtonState("stop");
        const sessionId = ttsSessionId;
        setTimeout(function() {
            if (sessionId !== ttsSessionId || !isSpeaking || ttsStopped) return;
            speakNextSentence();
        }, 100);
    } else {
        isSpeaking = false;
        ttsStopped = false;
        setTtsButtonState("play");
    }
}

function goToPreviousPage() {
    if (currentPage > 0) changePageWithTts(function() { currentPage--; });
}

function goToNextPage() {
    if (currentPage < pages.length - 1) changePageWithTts(function() { currentPage++; });
}

function cycleDisplayMode(direction) {
    if (blankModeEnabled) {
        displayMode = (displayMode + (direction === -1 ? 2 : 1)) % 3;
    } else {
        displayMode = displayMode === 1 ? 2 : 1;
    }
    displayPage();
}

// ═══════════════════════════════════════════════════════════════
//  TTS ENGINE
// ═══════════════════════════════════════════════════════════════

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

// Optional on-screen log for phones: open the app with ?debug in the URL.
const TTS_DEBUG = new URLSearchParams(location.search).has("debug");
function ttsLog(message) {
    console.log("[tts]", message);
    if (!TTS_DEBUG) return;
    let box = document.getElementById("tts-debug");
    if (!box) {
        box = document.createElement("pre");
        box.id = "tts-debug";
        box.style.cssText = "position:fixed;left:0;right:0;bottom:64px;margin:0;" +
            "padding:4px 8px;font:11px monospace;color:#0f0;background:rgba(0,0,0,.8);" +
            "z-index:999;pointer-events:none;white-space:pre-wrap;";
        document.body.appendChild(box);
    }
    box.textContent = (box.textContent + "\n" + message).split("\n").slice(-8).join("\n");
}

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

    utterance.onstart = function() {
        if (!isLive()) return;
        started = true;
        ttsLog("start");
    };

    utterance.onend = function() {
        if (!isLive()) return;
        ttsLog("end");
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
    if (!("speechSynthesis" in window)) {
        alert("Text-to-speech is not supported by this browser.");
        return;
    }

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
let isTrackingSwipe = false;

readingAreaSection.addEventListener("pointerdown", function(event) {
    if (event.pointerType !== "touch") return;
    if (event.target.closest("button")) return;

    swipeStartX = event.clientX;
    swipeStartY = event.clientY;
    isTrackingSwipe = true;
});

readingAreaSection.addEventListener("pointerup", function(event) {
    if (!isTrackingSwipe) return;
    isTrackingSwipe = false;

    const differenceX = event.clientX - swipeStartX;
    const differenceY = event.clientY - swipeStartY;
    const minimumSwipe = 50;

    if (Math.max(Math.abs(differenceX), Math.abs(differenceY)) < minimumSwipe) return;

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

readingArea.addEventListener("click", function(event) {
    const tapped = event.target.closest("p");
    if (!tapped) return;
    if (!readingArea.contains(tapped)) return;

    const paragraphs = Array.from(readingArea.querySelectorAll("p"));
    const index = paragraphs.indexOf(tapped);
    if (index === -1) return;

    jumpToSentence(index);
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

window.addEventListener("resize", function() {
    if (readerScreen.hidden) return;
    paginateReadingUnits();
    displayPage();
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

// Set the initial history state
history.replaceState({ view: 'home' }, '', '#home');

showHomeScreen();

window.addEventListener("pagehide", function() {
    window.speechSynthesis.cancel();
});