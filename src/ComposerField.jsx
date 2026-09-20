import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { filterCommands, mentionAt, slashQuery } from "./composer.js";

const api = window.workshop;

export const ComposerField = forwardRef(function ComposerField({
  draftKey,
  epoch,
  value,
  disabled,
  placeholder,
  commands,
  sendKey,
  onPersist,
  onEmptyChange,
  onSend,
}, ref) {
  const [text, setText] = useState(value || "");
  const [caret, setCaret] = useState(0);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [fileHits, setFileHits] = useState([]);
  const areaRef = useRef(null);
  const suggestRef = useRef(null);
  const textRef = useRef(text);
  const persistRef = useRef(onPersist);
  const emptyRef = useRef(onEmptyChange);
  const sendRef = useRef(onSend);
  textRef.current = text;
  persistRef.current = onPersist;
  emptyRef.current = onEmptyChange;
  sendRef.current = onSend;

  useEffect(() => {
    const next = value || "";
    setText(next);
    textRef.current = next;
    emptyRef.current?.(!String(next).trim());
  }, [draftKey, epoch]);

  useImperativeHandle(ref, () => ({
    focus() {
      areaRef.current?.focus();
    },
    get value() {
      return textRef.current;
    },
  }));

  const slash = slashQuery(text);
  const slashHits = slash != null ? filterCommands(commands, slash) : [];
  const mention = mentionAt(text, caret);
  const menuItems = mention ? fileHits : slashHits;
  const menuOpen = Boolean(menuItems.length);

  useEffect(() => {
    if (!mention) {
      setFileHits([]);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const rows = await api.searchFiles(mention.query, { hidden: mention.hidden });
        if (alive) {
          setFileHits(rows || []);
          setSuggestIndex(0);
        }
      } catch {
        if (alive) setFileHits([]);
      }
    }, 80);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [mention?.query, mention?.hidden, mention?.start]);

  useEffect(() => {
    setSuggestIndex(0);
  }, [slash, mention?.start]);

  useEffect(() => {
    const list = suggestRef.current;
    if (!list || !menuOpen) return;
    const item = list.children[suggestIndex];
    if (!(item instanceof HTMLElement)) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
    else if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
  }, [suggestIndex, menuOpen, menuItems.length]);

  const write = (next, pos) => {
    const valueText = String(next);
    setText(valueText);
    textRef.current = valueText;
    persistRef.current?.(valueText);
    emptyRef.current?.(!valueText.trim());
    if (pos != null) {
      setCaret(pos);
      setTimeout(() => {
        const el = areaRef.current;
        if (!el) return;
        el.focus();
        el.selectionStart = el.selectionEnd = pos;
      }, 0);
    }
  };

  const insertMention = (hit) => {
    if (!mention || !hit?.path) return;
    const next = `${text.slice(0, mention.start)}${mention.prefix}${hit.path} ${text.slice(caret)}`;
    write(next, mention.start + mention.prefix.length + hit.path.length + 1);
    setFileHits([]);
  };

  const fillSlash = (cmd) => {
    if (!cmd) return;
    const rest = text.replace(/^\/\S*/, "").trim();
    const next = rest ? `/${cmd.name} ${rest}` : `/${cmd.name} `;
    write(next, next.length);
    setSuggestIndex(0);
    setFileHits([]);
  };

  const onKeyDown = (event) => {
    if (menuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSuggestIndex((index) => (index + delta + menuItems.length) % menuItems.length);
      return;
    }
    if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      setFileHits([]);
      return;
    }
    if (menuOpen && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
      event.preventDefault();
      if (mention) insertMention(menuItems[suggestIndex] || menuItems[0]);
      else fillSlash(menuItems[suggestIndex] || menuItems[0]);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && (sendKey !== "ctrl-enter" || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendRef.current?.();
    }
  };

  return (
    <>
      {menuOpen ? (
        <div className="suggest" ref={suggestRef}>
          {mention
            ? fileHits.map((item, index) => (
                <button
                  type="button"
                  key={item.path}
                  className={index === suggestIndex ? "active" : ""}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertMention(item);
                  }}
                >
                  <b>{item.name}</b>
                  <small>{item.path}</small>
                </button>
              ))
            : slashHits.map((item, index) => (
                <button
                  type="button"
                  key={`${item.kind}-${item.name}`}
                  className={index === suggestIndex ? "active" : ""}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    fillSlash(item);
                  }}
                >
                  <b>/{item.name}</b>
                  <small>
                    {item.kind === "skill" ? "skill · " : ""}
                    {item.title}
                  </small>
                </button>
              ))}
        </div>
      ) : null}
      <textarea
        ref={areaRef}
        value={text}
        onChange={(event) => write(event.target.value, event.target.selectionStart || 0)}
        onClick={(event) => setCaret(event.target.selectionStart || 0)}
        onKeyUp={(event) => setCaret(event.target.selectionStart || 0)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={2}
        disabled={disabled}
      />
    </>
  );
});
