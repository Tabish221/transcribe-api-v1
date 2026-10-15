// languages.js - ISO-639-1 codes the API accepts. "auto" lets Whisper detect the language.
// The API knows ~100 languages; this list has the common ones. Add more codes if you need them.
export const LANGUAGES = [
  ['auto', 'Auto-detect'],
  ['en', 'English'],
  ['ar', 'Arabic'],
  ['bn', 'Bengali'],
  ['zh', 'Chinese'],
  ['nl', 'Dutch'],
  ['fr', 'French'],
  ['de', 'German'],
  ['el', 'Greek'],
  ['hi', 'Hindi'],
  ['id', 'Indonesian'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['ms', 'Malay'],
  ['fa', 'Persian'],
  ['pl', 'Polish'],
  ['pt', 'Portuguese'],
  ['pa', 'Punjabi'],
  ['ro', 'Romanian'],
  ['ru', 'Russian'],
  ['es', 'Spanish'],
  ['sv', 'Swedish'],
  ['tl', 'Tagalog'],
  ['ta', 'Tamil'],
  ['th', 'Thai'],
  ['tr', 'Turkish'],
  ['uk', 'Ukrainian'],
  ['ur', 'Urdu'],
  ['vi', 'Vietnamese'],
];

const NAMES = Object.fromEntries(LANGUAGES);

/** "en" -> "English"; unknown codes are shown as they are. */
export const languageName = (code) => (code ? NAMES[code] || code.toUpperCase() : 'Unknown');
