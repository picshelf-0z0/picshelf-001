/* Albums screen: Hide / Show Bars menu (placed between "New Album" and "Default Order").
   Allows hiding/showing:
   1. Albums & Tag Manager Tabs (.segmented-control-wrapper)
   2. Search Bar (.album-search-bar)
   3. Shortcuts Slide Bar (.album-filter-chips-strip)
   With user choice of:
   - Hide All the Time ('always')
   - Hide While Scrolling Only ('scroll')
   Plus a 1-tap Reset to Default option.
   Persisted across app and phone restarts via both localStorage and IndexedDB. */
(() => {
  'use strict';

  const STORAGE_KEY = 'photo_org_album_view_options';
  const STAMP_KEY = 'photo_org_album_view_options_at';
  const DEFAULTS = Object.freeze({
    hideTabs: false,
    hideSearch: false,
    hideShortcuts: false,
    mode: 'always' // 'always' | 'scroll'
  });

  const TRANSLATIONS_MAP = {
    en: {
      albums_view_btn: 'Hide Bars',
      albums_view_menu_title: 'Hide / Show Bars',
      albums_hide_all_label: 'Hide All 3 Bars',
      albums_hide_all_desc: 'Save space to see 4 albums on screen',
      albums_hide_tabs_label: 'Albums & Tag Manager Tabs',
      albums_hide_tabs_desc: 'Hide top Albums / Tag Manager tab bar',
      albums_hide_search_label: 'Search Bar',
      albums_hide_search_desc: 'Hide album search box',
      albums_hide_shortcuts_label: 'Shortcuts Slide Bar',
      albums_hide_shortcuts_desc: 'Hide horizontal filter & 3D shortcut chips',
      albums_hide_mode_title: 'When to Hide Selected Bars',
      albums_hide_mode_always: 'All the Time',
      albums_hide_mode_always_desc: 'Stay hidden on Albums screen until changed',
      albums_hide_mode_scroll: 'While Scrolling Only',
      albums_hide_mode_scroll_desc: 'Visible at top, hide while scrolling down',
      albums_view_reset_all: 'Reset to Default (Show All)'
    },
    hi: {
      albums_view_btn: 'बार छिपाएँ',
      albums_view_menu_title: 'बार छिपाएँ / दिखाएँ',
      albums_hide_all_label: 'तीनों बार छिपाएँ',
      albums_hide_all_desc: 'स्क्रीन पर 4 एल्बम देखने के लिए जगह बचाएँ',
      albums_hide_tabs_label: 'एल्बम और टैग मैनेजर टैब',
      albums_hide_tabs_desc: 'ऊपरी एल्बम / टैग मैनेजर टैब बार छिपाएँ',
      albums_hide_search_label: 'खोज बार (Search Bar)',
      albums_hide_search_desc: 'एल्बम खोज बॉक्स छिपाएँ',
      albums_hide_shortcuts_label: 'शॉर्टकट स्लाइड बार',
      albums_hide_shortcuts_desc: 'क्षैतिज फ़िल्टर और 3D शॉर्टकट चिप्स छिपाएँ',
      albums_hide_mode_title: 'चुने गए बार कब छिपाएँ',
      albums_hide_mode_always: 'हर समय (All the Time)',
      albums_hide_mode_always_desc: 'बदलने तक एल्बम स्क्रीन पर छिपा रखें',
      albums_hide_mode_scroll: 'केवल स्क्रॉल करते समय',
      albums_hide_mode_scroll_desc: 'ऊपर दिखाएँ, नीचे स्क्रॉल करते समय छिपाएँ',
      albums_view_reset_all: 'डिफ़ॉल्ट पर रीसेट करें (सब दिखाएँ)'
    },
    bn: {
      albums_view_btn: 'বার লুকান',
      albums_view_menu_title: 'বার লুকান / দেখান',
      albums_hide_all_label: 'সব ৩টি বার লুকান',
      albums_hide_all_desc: 'স্ক্রিনে ৪টি অ্যালবাম দেখতে জায়গা বাঁচান',
      albums_hide_tabs_label: 'অ্যালবাম ও ট্যাগ ম্যানেজার ট্যাব',
      albums_hide_tabs_desc: 'উপরের অ্যালবাম / ট্যাগ ম্যানেজার ট্যাব লুকান',
      albums_hide_search_label: 'সার্চ বার',
      albums_hide_search_desc: 'অ্যালবাম খোঁজার বক্স লুকান',
      albums_hide_shortcuts_label: 'শর্টকাট স্লাইড বার',
      albums_hide_shortcuts_desc: 'অনুভূমিক ফিল্টার ও 3D শর্টকাট চিপস লুকান',
      albums_hide_mode_title: 'কখন লুকানো হবে',
      albums_hide_mode_always: 'সব সময়',
      albums_hide_mode_always_desc: 'পরিবর্তন না করা পর্যন্ত অ্যালবাম স্ক্রিনে লুকিয়ে রাখুন',
      albums_hide_mode_scroll: 'শুধু স্ক্রল করার সময়',
      albums_hide_mode_scroll_desc: 'উপরে দেখাবে, নিচে স্ক্রল করলে লুকাবে',
      albums_view_reset_all: 'ডিফল্টে রিসেট করুন (সব দেখান)'
    },
    te: {
      albums_view_btn: 'బార్స్ దాచు',
      albums_view_menu_title: 'బార్స్ దాచు / చూపించు',
      albums_hide_all_label: 'మొత్తం 3 బార్స్ దాచు',
      albums_hide_all_desc: 'స్క్రీన్‌పై 4 ఆల్బమ్‌లు చూడటానికి స్థలం ఆదా చేయండి',
      albums_hide_tabs_label: 'ఆల్బమ్స్ & ట్యాగ్ మేనేజర్ ట్యాబ్‌లు',
      albums_hide_tabs_desc: 'పైన ఉన్న ఆల్బమ్స్ / ట్యాగ్ మేనేజర్ ట్యాబ్ బార్ దాచండి',
      albums_hide_search_label: 'సెర్చ్ బార్',
      albums_hide_search_desc: 'ఆల్బమ్ సెర్చ్ బాక్స్ దాచండి',
      albums_hide_shortcuts_label: 'షార్ట్‌కట్స్ స్లైడ్ బార్',
      albums_hide_shortcuts_desc: 'హారిజాంటల్ ఫిల్టర్ & 3D షార్ట్‌కట్ చిప్స్ దాచండి',
      albums_hide_mode_title: 'ఎప్పుడు దాచాలి',
      albums_hide_mode_always: 'ఎల్లప్పుడూ (All the Time)',
      albums_hide_mode_always_desc: 'మీరు మార్చే వరకు ఆల్బమ్స్ స్క్రీన్‌పై దాచి ఉంచండి',
      albums_hide_mode_scroll: 'స్క్రోల్ చేసేటప్పుడు మాత్రమే',
      albums_hide_mode_scroll_desc: 'పైన కనిపిస్తుంది, కిందికి స్క్రోల్ చేసేటప్పుడు దాగుతుంది',
      albums_view_reset_all: 'డిఫాల్ట్‌కు రీసెట్ చేయండి (అన్నీ చూపించు)'
    },
    ta: {
      albums_view_btn: 'பார்கள் மறை',
      albums_view_menu_title: 'பார்களை மறை / காட்டு',
      albums_hide_all_label: '3 பார்களையும் மறை',
      albums_hide_all_desc: 'திரையில் 4 ஆல்பங்களைக் காண இடத்தைச் சேமிக்கவும்',
      albums_hide_tabs_label: 'ஆல்பங்கள் & டேக் மேனேஜர் டேப்கள்',
      albums_hide_tabs_desc: 'மேல் ஆல்பங்கள் / டேக் மேனேஜர் பட்டியை மறை',
      albums_hide_search_label: 'தேடல் பட்டி (Search Bar)',
      albums_hide_search_desc: 'ஆல்பம் தேடல் பெட்டியை மறை',
      albums_hide_shortcuts_label: 'ஷார்ட்கட் ஸ்லைடு பார்',
      albums_hide_shortcuts_desc: 'கிடைமட்ட வடிப்பான் & 3D ஷார்ட்கட்களை மறை',
      albums_hide_mode_title: 'எப்போது மறைக்க வேண்டும்',
      albums_hide_mode_always: 'எல்லா நேரத்திலும்',
      albums_hide_mode_always_desc: 'மாற்றும் வரை ஆல்பம் திரையில் மறைந்திருக்கும்',
      albums_hide_mode_scroll: 'ஸ்க்ரோல் செய்யும்போது மட்டும்',
      albums_hide_mode_scroll_desc: 'மேலே தெரியும், கீழே ஸ்க்ரோல் செய்யும்போது மறையும்',
      albums_view_reset_all: 'மீட்டமை (அனைத்தையும் காட்டு)'
    },
    mr: {
      albums_view_btn: 'बार लपवा',
      albums_view_menu_title: 'बार लपवा / दाखवा',
      albums_hide_all_label: 'सर्व ३ बार लपवा',
      albums_hide_all_desc: 'स्क्रीनवर ४ अल्बम पाहण्यासाठी जागा वाचवा',
      albums_hide_tabs_label: 'अल्बम आणि टॅग मॅनेजर टॅब',
      albums_hide_tabs_desc: 'वरील अल्बम / टॅग मॅनेजर टॅब बार लपवा',
      albums_hide_search_label: 'सर्च बार',
      albums_hide_search_desc: 'अल्बम शोध बॉक्स लपवा',
      albums_hide_shortcuts_label: 'शॉर्टकट स्लाइड बार',
      albums_hide_shortcuts_desc: 'आडवे फिल्टर आणि 3D शॉर्टकट चिप्स लपवा',
      albums_hide_mode_title: 'निवडलेले बार कधी लपवायचे',
      albums_hide_mode_always: 'नेहमी (All the Time)',
      albums_hide_mode_always_desc: 'बदलेपर्यंत अल्बम स्क्रीनवर लपवून ठेवा',
      albums_hide_mode_scroll: 'फक्त स्क्रोल करताना',
      albums_hide_mode_scroll_desc: 'वर दिसेल, खाली स्क्रोल करताना लपेल',
      albums_view_reset_all: 'डिफॉल्टवर रीसेट करा (सर्व दाखवा)'
    },
    gu: {
      albums_view_btn: 'બાર છુપાવો',
      albums_view_menu_title: 'બાર છુપાવો / બતાવો',
      albums_hide_all_label: 'બધા 3 બાર છુપાવો',
      albums_hide_all_desc: 'સ્ક્રીન પર 4 આલ્બમ જોવા માટે જગ્યા બચાવો',
      albums_hide_tabs_label: 'આલ્બમ અને ટૅગ મેનેજર ટૅબ્સ',
      albums_hide_tabs_desc: 'ઉપરનો આલ્બમ / ટૅગ મેનેજર ટૅબ બાર છુપાવો',
      albums_hide_search_label: 'સર્ચ બાર',
      albums_hide_search_desc: 'આલ્બમ સર્ચ બોક્સ છુપાવો',
      albums_hide_shortcuts_label: 'શોર્ટકટ સ્લાઇડ બાર',
      albums_hide_shortcuts_desc: 'આડા ફિલ્ટર અને 3D શોર્ટકટ ચિપ્સ છુપાવો',
      albums_hide_mode_title: 'પસંદ કરેલા બાર ક્યારે છુપાવવા',
      albums_hide_mode_always: 'હંમેશા (All the Time)',
      albums_hide_mode_always_desc: 'બદલાય નહીં ત્યાં સુધી આલ્બમ સ્ક્રીન પર છુપાવેલા રાખો',
      albums_hide_mode_scroll: 'ફક્ત સ્ક્રોલ કરતી વખતે',
      albums_hide_mode_scroll_desc: 'ઉપર દેખાશે, નીચે સ્ક્રોલ કરતી વખતે છુપાશે',
      albums_view_reset_all: 'ડિફોલ્ટ પર રીસેટ કરો (બધું બતાવો)'
    },
    kn: {
      albums_view_btn: 'ಬಾರ್ ಮರೆಮಾಡಿ',
      albums_view_menu_title: 'ಬಾರ್‌ಗಳನ್ನು ಮರೆಮಾಡಿ / ತೋರಿಸಿ',
      albums_hide_all_label: 'ಎಲ್ಲಾ 3 ಬಾರ್‌ಗಳನ್ನು ಮರೆಮಾಡಿ',
      albums_hide_all_desc: 'ಪರದೆಯ ಮೇಲೆ 4 ಆಲ್ಬಮ್‌ಗಳನ್ನು ನೋಡಲು ಸ್ಥಳ ಉಳಿಸಿ',
      albums_hide_tabs_label: 'ಆಲ್ಬಮ್‌ಗಳು & ಟ್ಯಾಗ್ ಮ್ಯಾನೇಜರ್ ಟ್ಯಾಬ್‌ಗಳು',
      albums_hide_tabs_desc: 'ಮೇಲಿನ ಆಲ್ಬಮ್ / ಟ್ಯಾಗ್ ಮ್ಯಾನೇಜರ್ ಟ್ಯಾಬ್ ಮರೆಮಾಡಿ',
      albums_hide_search_label: 'ಸರ್ಚ್ ಬಾರ್',
      albums_hide_search_desc: 'ಆಲ್ಬಮ್ ಹುಡುಕಾಟ ಪೆಟ್ಟಿಗೆಯನ್ನು ಮರೆಮಾಡಿ',
      albums_hide_shortcuts_label: 'ಶಾರ್ಟ್‌ಕಟ್ಸ್ ಸ್ಲೈಡ್ ಬಾರ್',
      albums_hide_shortcuts_desc: 'ಅಡ್ಡ ಫಿಲ್ಟರ್ ಮತ್ತು 3D ಶಾರ್ಟ್‌ಕಟ್ ಚಿಪ್ಸ್ ಮರೆಮಾಡಿ',
      albums_hide_mode_title: 'ಯಾವಾಗ ಮರೆಮಾಡಬೇಕು',
      albums_hide_mode_always: 'ಎಲ್ಲಾ ಸಮಯದಲ್ಲೂ',
      albums_hide_mode_always_desc: 'ಬದಲಾಯಿಸುವವರೆಗೆ ಆಲ್ಬಮ್ ಪರದೆಯಲ್ಲಿ ಮರೆಮಾಡಿ',
      albums_hide_mode_scroll: 'ಸ್ಕ್ರಾಲ್ ಮಾಡುವಾಗ ಮಾತ್ರ',
      albums_hide_mode_scroll_desc: 'ಮೇಲೆ ಕಾಣಿಸುತ್ತದೆ, ಕೆಳಗೆ ಸ್ಕ್ರಾಲ್ ಮಾಡುವಾಗ ಮರೆಯಾಗುತ್ತದೆ',
      albums_view_reset_all: 'ಡೀಫಾಲ್ಟ್‌ಗೆ ಮರುಹೊಂದಿಸಿ (ಎಲ್ಲಾ ತೋರಿಸಿ)'
    },
    ml: {
      albums_view_btn: 'ബാറുകൾ മറയ്ക്കുക',
      albums_view_menu_title: 'ബാറുകൾ മറയ്ക്കുക / കാണിക്കുക',
      albums_hide_all_label: '3 ബാറുകളും മറയ്ക്കുക',
      albums_hide_all_desc: 'സ്ക്രീനിൽ 4 ആൽബങ്ങൾ കാണാൻ സ്ഥലം ലാഭിക്കുക',
      albums_hide_tabs_label: 'ആൽബങ്ങൾ & ടാഗ് മാനേജർ ടാബുകൾ',
      albums_hide_tabs_desc: 'മുകളിലെ ആൽബങ്ങൾ / ടാഗ് മാനേജർ ടാബ് മറയ്ക്കുക',
      albums_hide_search_label: 'സെർച്ച് ബാർ',
      albums_hide_search_desc: 'ആൽബം തിരയൽ ബോക്സ് മറയ്ക്കുക',
      albums_hide_shortcuts_label: 'ഷോർട്ട്കട്ട് സ്ലൈഡ് ബാർ',
      albums_hide_shortcuts_desc: 'ഫിൽട്ടർ & 3D ഷോർട്ട്കട്ട് ചിപ്പുകൾ മറയ്ക്കുക',
      albums_hide_mode_title: 'എപ്പോൾ മറയ്ക്കണം',
      albums_hide_mode_always: 'എല്ലാ സമയത്തും',
      albums_hide_mode_always_desc: 'മാറ്റുന്നതുവരെ ആൽബം സ്ക്രീനിൽ മറച്ചുവെക്കുക',
      albums_hide_mode_scroll: 'സ്ക്രോൾ ചെയ്യുമ്പോൾ മാത്രം',
      albums_hide_mode_scroll_desc: 'മുകളിൽ കാണിക്കും, താഴേക്ക് സ്ക്രോൾ ചെയ്യുമ്പോൾ മറയും',
      albums_view_reset_all: 'റീസെറ്റ് ചെയ്യുക (എല്ലാം കാണിക്കുക)'
    },
    pa: {
      albums_view_btn: 'ਬਾਰ ਲੁਕਾਓ',
      albums_view_menu_title: 'ਬਾਰ ਲੁਕਾਓ / ਦਿਖਾਓ',
      albums_hide_all_label: 'ਸਾਰੇ 3 ਬਾਰ ਲੁਕਾਓ',
      albums_hide_all_desc: 'ਸਕ੍ਰੀਨ ਤੇ 4 ਐਲਬਮਾਂ ਦੇਖਣ ਲਈ ਜਗ੍ਹਾ ਬਚਾਓ',
      albums_hide_tabs_label: 'ਐਲਬਮਾਂ ਅਤੇ ਟੈਗ ਮੈਨੇਜਰ ਟੈਬਾਂ',
      albums_hide_tabs_desc: 'ਉੱਪਰਲੀ ਐਲਬਮ / ਟੈਗ ਮੈਨੇਜਰ ਟੈਬ ਬਾਰ ਲੁਕਾਓ',
      albums_hide_search_label: 'ਸਰਚ ਬਾਰ',
      albums_hide_search_desc: 'ਐਲਬਮ ਖੋਜ ਬਾਕਸ ਲੁਕਾਓ',
      albums_hide_shortcuts_label: 'ਸ਼ਾਰਟਕੱਟ ਸਲਾਈਡ ਬਾਰ',
      albums_hide_shortcuts_desc: 'ਲੇਟਵੇਂ ਫਿਲਟਰ ਅਤੇ 3D ਸ਼ਾਰਟਕੱਟ ਚਿੱਪਸ ਲੁਕਾਓ',
      albums_hide_mode_title: 'ਚੁਣੇ ਗਏ ਬਾਰ ਕਦੋਂ ਲੁਕਾਉਣੇ ਹਨ',
      albums_hide_mode_always: 'ਹਰ ਸਮੇਂ (All the Time)',
      albums_hide_mode_always_desc: 'ਬਦਲਣ ਤੱਕ ਐਲਬਮ ਸਕ੍ਰੀਨ ਤੇ ਲੁਕਾ ਕੇ ਰੱਖੋ',
      albums_hide_mode_scroll: 'ਸਿਰਫ਼ ਸਕ੍ਰੌਲ ਕਰਨ ਵੇਲੇ',
      albums_hide_mode_scroll_desc: 'ਉੱਪਰ ਦਿਖਾਓ, ਹੇਠਾਂ ਸਕ੍ਰੌਲ ਕਰਨ ਵੇਲੇ ਲੁਕਾਓ',
      albums_view_reset_all: 'ਡਿਫੌਲਟ ਤੇ ਰੀਸੈਟ ਕਰੋ (ਸਭ ਦਿਖਾਓ)'
    }
  };

  function registerTranslations() {
    const dict = window.I18N_TRANSLATIONS;
    if (typeof dict !== 'object' || !dict) return;
    for (const [lang, entries] of Object.entries(TRANSLATIONS_MAP)) {
      if (dict[lang]) Object.assign(dict[lang], entries);
    }
  }
  registerTranslations();

  const el = id => document.getElementById(id);
  const app = () => window.state;

  function sanitize(raw) {
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
    return {
      hideTabs: !!raw.hideTabs,
      hideSearch: !!raw.hideSearch,
      hideShortcuts: !!raw.hideShortcuts,
      mode: raw.mode === 'scroll' ? 'scroll' : 'always'
    };
  }

  function samePrefs(a, b) {
    return !!a && !!b &&
      a.hideTabs === b.hideTabs &&
      a.hideSearch === b.hideSearch &&
      a.hideShortcuts === b.hideShortcuts &&
      a.mode === b.mode;
  }

  function anySelected(p) {
    return !!(p.hideTabs || p.hideSearch || p.hideShortcuts);
  }

  function allSelected(p) {
    return !!(p.hideTabs && p.hideSearch && p.hideShortcuts);
  }

  // ---- Dual localStorage + IndexedDB persistence ----------------------------
  const backup = (() => {
    const DB_NAME = 'picshelf_preferences', STORE = 'preferences', RECORD = 'albumViewOptions';
    let opening = null;
    function open() {
      if (!opening) {
        opening = new Promise(resolve => {
          let request;
          try { request = indexedDB.open(DB_NAME, 1); } catch (_) { resolve(null); return; }
          request.onupgradeneeded = () => {
            try { request.result.createObjectStore(STORE); } catch (_) {}
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        });
      }
      return opening;
    }
    function read() {
      return open().then(db => db && new Promise(resolve => {
        try {
          const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
      }));
    }
    let queued = null, writing = false;
    function write(record) {
      queued = record;
      if (writing) return;
      writing = true;
      (async () => {
        while (queued) {
          const next = queued;
          queued = null;
          const db = await open();
          if (!db) break;
          await new Promise(resolve => {
            try {
              const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
              tx.objectStore(STORE).put(next, RECORD);
              tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
            } catch (_) { resolve(); }
          });
        }
        writing = false;
      })();
    }
    return { read, write };
  })();

  let prefs = { ...DEFAULTS };
  let savedAt = 0;
  let chosenNow = false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      prefs = sanitize(JSON.parse(raw));
      savedAt = Number(localStorage.getItem(STAMP_KEY)) || 0;
    }
  } catch (_) {}

  function savePrefs() {
    chosenNow = true;
    savedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      localStorage.setItem(STAMP_KEY, String(savedAt));
    } catch (_) {}
    backup.write({ prefs: { ...prefs }, at: savedAt });
  }

  backup.read().then(record => {
    if (chosenNow) return;
    const diskPrefs = record && record.prefs ? sanitize(record.prefs) : null;
    const at = diskPrefs ? Number(record.at) || 0 : 0;
    if (!diskPrefs || (samePrefs(diskPrefs, prefs) && at <= savedAt)) {
      if (savedAt > 0 && (!diskPrefs || !samePrefs(diskPrefs, prefs) || at !== savedAt)) {
        backup.write({ prefs: { ...prefs }, at: savedAt });
      }
      return;
    }
    if (at > savedAt) {
      prefs = diskPrefs;
      savedAt = at;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
        localStorage.setItem(STAMP_KEY, String(at));
      } catch (_) {}
      sync();
    }
  });

  // Flush localStorage on lifecycle events to guarantee persistence on restart
  const flushLocal = () => {
    if (!savedAt) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      localStorage.setItem(STAMP_KEY, String(savedAt));
    } catch (_) {}
  };
  window.addEventListener('pagehide', flushLocal);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushLocal();
  });

  // ---- Scroll tracking for "While Scrolling Only" mode ----------------------
  const DIRECTION_SLOP_PX = 8;
  const TOGGLE_COOLDOWN_MS = 180;
  let scrollHidden = false;
  let lastTop = 0;
  let travel = 0;
  let lastHideToggleAt = -Infinity;

  const albumsActive = () => !!el('albumsScreen')?.classList.contains('active') &&
    ((app()?.currentAlbumView || 'albums') === 'albums');

  function setScrollHidden(next) {
    if (next === scrollHidden) return;
    scrollHidden = next;
    lastHideToggleAt = performance.now();
    travel = 0;
    applyDOMClasses();
    const vp = document.querySelector('.app-viewport');
    if (vp) lastTop = vp.scrollTop;
  }

  function onViewportScroll(event) {
    const top = event.currentTarget.scrollTop;
    const delta = top - lastTop;
    lastTop = top;
    if (!albumsActive() || !anySelected(prefs) || prefs.mode !== 'scroll') {
      if (scrollHidden) setScrollHidden(false);
      travel = 0;
      return;
    }
    const now = performance.now();
    if (now - lastHideToggleAt < TOGGLE_COOLDOWN_MS) {
      travel = 0;
      return;
    }
    if (top <= 2) {
      if (scrollHidden) setScrollHidden(false);
      travel = 0;
      return;
    }
    if (!delta) return;
    travel = (travel > 0) === (delta > 0) ? travel + delta : delta;
    if (travel >= DIRECTION_SLOP_PX && top > 10) {
      setScrollHidden(true);
    } else if (travel <= -DIRECTION_SLOP_PX) {
      setScrollHidden(false);
    }
  }

  // ---- Apply classes & synchronize button / menu UI -------------------------
  function applyDOMClasses() {
    const screen = el('albumsScreen');
    if (!screen) return;
    const isAlbumsView = (app()?.currentAlbumView || 'albums') === 'albums';
    const hasAny = anySelected(prefs);
    const effectiveHide = isAlbumsView && hasAny && (prefs.mode === 'always' || scrollHidden);

    screen.classList.toggle('albums-hide-tabs', effectiveHide && prefs.hideTabs);
    screen.classList.toggle('albums-hide-search', effectiveHide && prefs.hideSearch);
    screen.classList.toggle('albums-hide-shortcuts', effectiveHide && prefs.hideShortcuts);
    screen.classList.toggle('albums-has-hidden-bars', effectiveHide);
    screen.classList.toggle('albums-scroll-hidden-active', isAlbumsView && hasAny && prefs.mode === 'scroll' && scrollHidden);
  }

  function sync() {
    registerTranslations();
    const s = app();
    const wrapper = el('albumViewOptions');
    if (wrapper) {
      const show = !s || (s.currentAlbumView || 'albums') === 'albums';
      if (wrapper.hidden === show) wrapper.hidden = !show;
      if (!show) closeMenu();
    }

    applyDOMClasses();

    const hasAny = anySelected(prefs);
    const hasAll = allSelected(prefs);
    const isDefault = !hasAny && prefs.mode === 'always';

    const dot = el('albumViewOptionsDot');
    if (dot && dot.hidden !== !hasAny) dot.hidden = !hasAny;

    const icon = el('albumViewOptionsIcon');
    const targetIcon = hasAny ? 'fa-solid fa-eye-slash' : 'fa-solid fa-sliders';
    if (icon && icon.className !== targetIcon) icon.className = targetIcon;

    const btn = el('albumViewOptionsBtn');
    if (btn) btn.classList.toggle('has-active-hide', hasAny);

    const label = el('albumViewOptionsLabel');
    if (label && typeof window.t === 'function') {
      const text = window.t('albums_view_btn');
      if (text && label.textContent !== text) label.textContent = text;
    }

    const menu = el('albumViewOptionsMenu');
    if (!menu) return;

    const states = {
      all: hasAll,
      tabs: prefs.hideTabs,
      search: prefs.hideSearch,
      shortcuts: prefs.hideShortcuts
    };
    menu.querySelectorAll('.album-view-bar-option').forEach(option => {
      const key = option.dataset.bar;
      const on = !!states[key];
      option.classList.toggle('active', on);
      option.setAttribute('aria-checked', on ? 'true' : 'false');
    });

    menu.querySelectorAll('.album-view-mode-option').forEach(option => {
      const on = option.dataset.hideMode === prefs.mode;
      option.classList.toggle('active', on);
      option.setAttribute('aria-checked', on ? 'true' : 'false');
    });

    const resetTop = el('albumViewResetBtn');
    if (resetTop) resetTop.hidden = isDefault;

    const resetFooter = el('albumViewResetFooterBtn');
    if (resetFooter) resetFooter.disabled = isDefault;
  }

  function fit(menu) {
    menu.style.maxHeight = '';
    menu.style.left = '50%';
    menu.style.right = 'auto';
    menu.style.transform = 'translateX(-50%)';
    const rect = menu.getBoundingClientRect();
    const margin = 12;
    let shiftX = 0;
    if (rect.left < margin) {
      shiftX = margin - rect.left;
    } else if (rect.right > window.innerWidth - margin) {
      shiftX = (window.innerWidth - margin) - rect.right;
    }
    if (shiftX !== 0) {
      menu.style.transform = `translateX(calc(-50% + ${Math.round(shiftX)}px))`;
    }
    const nav = document.querySelector('.bottom-nav');
    const navBox = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect() : null;
    const navTop = navBox && navBox.height > 0 ? navBox.top : window.innerHeight;
    const bottom = Math.min(window.innerHeight, navTop) - 10;
    menu.style.maxHeight = `${Math.max(200, Math.floor(bottom - rect.top))}px`;
  }

  let restoreBack = null;
  function closeMenu() {
    const menu = el('albumViewOptionsMenu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    el('albumViewOptionsBtn')?.setAttribute('aria-expanded', 'false');
    el('albumViewOptions')?.classList.remove('open');
    if (restoreBack) {
      restoreBack();
      restoreBack = null;
    }
  }

  function openMenu() {
    window.AlbumSort?.closeMenu?.();
    const menu = el('albumViewOptionsMenu');
    if (!menu) return;
    menu.hidden = false;
    el('albumViewOptionsBtn')?.setAttribute('aria-expanded', 'true');
    el('albumViewOptions')?.classList.add('open');
    menu.scrollTop = 0;
    sync();
    fit(menu);
    const previous = window.handleNativeBackPressed;
    const handler = function () {
      closeMenu();
      return true;
    };
    window.handleNativeBackPressed = handler;
    restoreBack = () => {
      if (window.handleNativeBackPressed === handler) window.handleNativeBackPressed = previous;
    };
  }

  function toggleMenu(event) {
    if (event) event.stopPropagation();
    const menu = el('albumViewOptionsMenu');
    if (!menu) return;
    if (menu.hidden) openMenu();
    else closeMenu();
  }

  function toggleBar(bar) {
    if (bar === 'tabs') prefs.hideTabs = !prefs.hideTabs;
    else if (bar === 'search') prefs.hideSearch = !prefs.hideSearch;
    else if (bar === 'shortcuts') prefs.hideShortcuts = !prefs.hideShortcuts;
    else return;
    if (prefs.mode === 'scroll') {
      const vp = document.querySelector('.app-viewport');
      scrollHidden = !!(vp && vp.scrollTop > 10);
    }
    savePrefs();
    sync();
  }

  function toggleAllBars() {
    const next = !allSelected(prefs);
    prefs.hideTabs = next;
    prefs.hideSearch = next;
    prefs.hideShortcuts = next;
    if (prefs.mode === 'scroll') {
      const vp = document.querySelector('.app-viewport');
      scrollHidden = !!(vp && vp.scrollTop > 10);
    }
    savePrefs();
    sync();
  }

  function setMode(mode) {
    const nextMode = mode === 'scroll' ? 'scroll' : 'always';
    // If the user picks a hide mode when no bar was checked yet, check all 3 bars automatically
    if (!anySelected(prefs)) {
      prefs.hideTabs = true;
      prefs.hideSearch = true;
      prefs.hideShortcuts = true;
    }
    prefs.mode = nextMode;
    if (nextMode === 'scroll') {
      const vp = document.querySelector('.app-viewport');
      scrollHidden = !!(vp && vp.scrollTop > 10);
    } else {
      scrollHidden = false;
    }
    savePrefs();
    sync();
  }

  function reset() {
    prefs = { ...DEFAULTS };
    scrollHidden = false;
    savePrefs();
    sync();
    closeMenu();
  }

  document.addEventListener('click', event => {
    const menu = el('albumViewOptionsMenu');
    if (!menu || menu.hidden) return;
    const wrapper = el('albumViewOptions');
    if (wrapper && wrapper.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  }, true);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMenu();
  });
  window.addEventListener('resize', closeMenu);

  function attach() {
    registerTranslations();
    const viewport = document.querySelector('.app-viewport');
    if (viewport && !viewport._albumViewOptionsScrollAttached) {
      viewport._albumViewOptionsScrollAttached = true;
      lastTop = viewport.scrollTop;
      viewport.addEventListener('scroll', event => {
        closeMenu();
        onViewportScroll(event);
      }, { passive: true });
    }
    if (typeof window.applyTranslationsToDOM === 'function' && !window.applyTranslationsToDOM._albumViewWrapped) {
      const origApply = window.applyTranslationsToDOM;
      const wrapped = function (...args) {
        registerTranslations();
        const res = origApply.apply(this, args);
        sync();
        return res;
      };
      wrapped._albumViewWrapped = true;
      window.applyTranslationsToDOM = wrapped;
    }
    window.applyTranslationsToDOM?.();
    sync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();

  window.AlbumViewOptions = {
    sync,
    toggleMenu,
    closeMenu,
    toggleBar,
    toggleAllBars,
    setMode,
    reset,
    get prefs() { return { ...prefs }; }
  };
})();
