import { Search, X, } from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState, } from "react";
import {
  COMMON_SPOKEN_LANGUAGE_CODES,
  getLanguageDisplayName,
  SUPPORTED_SPOKEN_LANGUAGE_CODES,
} from "../../utils/language";

const mono = { fontFamily: "'IBM Plex Mono', monospace", };

function getLanguageSuggestions(value: string[], query: string,) {
  const normalizedQuery = query.trim().toLowerCase();
  const selectedLanguages = new Set(value,);
  const source = normalizedQuery ? SUPPORTED_SPOKEN_LANGUAGE_CODES : COMMON_SPOKEN_LANGUAGE_CODES;
  const matches = source.filter((code,) => {
    if (selectedLanguages.has(code,)) return false;
    if (!normalizedQuery) return true;
    const languageName = getLanguageDisplayName(code,).toLowerCase();
    return code.includes(normalizedQuery,) || languageName.includes(normalizedQuery,);
  },);

  if (matches.length > 0 || normalizedQuery) {
    return matches.slice(0, 8,);
  }

  return SUPPORTED_SPOKEN_LANGUAGE_CODES
    .filter((code,) => !selectedLanguages.has(code,))
    .slice(0, 8,);
}

export function SpokenLanguagesField(
  {
    value,
    onChange,
  }: {
    value: string[];
    onChange: (nextValue: string[],) => void;
  },
) {
  const inputRef = useRef<HTMLInputElement>(null,);
  const [query, setQuery,] = useState("",);
  const [focused, setFocused,] = useState(false,);
  const [selectedIndex, setSelectedIndex,] = useState(0,);

  const suggestions = useMemo(() => getLanguageSuggestions(value, query,), [query, value,],);
  const activeIndex = suggestions.length === 0 ? -1 : Math.min(selectedIndex, suggestions.length - 1,);
  const hideIdleInput = value.length > 0 && !focused && !query;

  const selectLanguage = (code: string,) => {
    if (value.includes(code,)) return;
    onChange([...value, code,],);
    setQuery("",);
    setSelectedIndex(0,);
    inputRef.current?.focus();
  };

  const removeLanguage = (code: string,) => {
    onChange(value.filter((language,) => language !== code),);
    setSelectedIndex(0,);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>,) => {
    if (event.key === "Backspace" && !query && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1,),);
      return;
    }

    if (!focused || suggestions.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current,) => Math.min(current + 1, suggestions.length - 1,));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current,) => Math.max(current - 1, 0,));
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const nextCode = suggestions[activeIndex >= 0 ? activeIndex : 0];
      if (nextCode) {
        selectLanguage(nextCode,);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setFocused(false,);
      setQuery("",);
      setSelectedIndex(0,);
      inputRef.current?.blur();
    }
  };

  return (
    <div className="relative">
      <div
        className="flex min-h-[42px] w-full flex-wrap items-center gap-1.5 border border-gray-200 px-3 py-2 text-sm transition-all focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-500/30"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((code,) => (
          <span
            key={code}
            className="inline-flex items-center gap-1 rounded-none border border-violet-200 bg-violet-50 px-2 py-1 text-xs text-violet-700"
            style={mono}
          >
            <span>{getLanguageDisplayName(code,)}</span>
            <button
              type="button"
              onClick={(event,) => {
                event.stopPropagation();
                removeLanguage(code,);
              }}
              className="text-violet-500 transition-colors hover:text-violet-700"
              aria-label={`Remove ${getLanguageDisplayName(code,)}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {value.length === 0 && <Search className="h-4 w-4 text-gray-400" />}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event,) => {
            setQuery(event.target.value,);
            setSelectedIndex(0,);
          }}
          onFocus={() => {
            setFocused(true,);
            setSelectedIndex(0,);
          }}
          onBlur={() => {
            setFocused(false,);
            setQuery("",);
            setSelectedIndex(0,);
          }}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={focused && suggestions.length > 0}
          aria-controls="spoken-language-options"
          aria-activedescendant={activeIndex >= 0 ? `spoken-language-option-${activeIndex}` : undefined}
          aria-label="Add spoken language"
          placeholder={value.length === 0 ? "Search languages" : ""}
          className={`bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 ${
            hideIdleInput
              ? "w-0 min-w-0 flex-none opacity-0"
              : "min-w-[96px] flex-1"
          }`}
          style={mono}
        />
      </div>

      {focused && suggestions.length > 0 && (
        <div
          id="spoken-language-options"
          role="listbox"
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto border border-gray-200 bg-white shadow-lg"
        >
          {suggestions.map((code, index,) => (
            <button
              key={code}
              id={`spoken-language-option-${index}`}
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              onMouseDown={(event,) => event.preventDefault()}
              onMouseEnter={() => setSelectedIndex(index,)}
              onClick={() => selectLanguage(code,)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                activeIndex === index
                  ? "bg-violet-50 text-violet-700"
                  : "text-gray-700 hover:bg-gray-50"
              }`}
              style={mono}
            >
              <span>{getLanguageDisplayName(code,)}</span>
              <span className="text-xs text-gray-400">{code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
