import { useEffect, useMemo, useState, } from "react";

import "./ReadOnlyHeroNote.css";

const IDEA_TEXT = "super cool name for an ai notetaker char.com";
const BUILD_PROMPT = "chest workout for today";
const TASK_ONE_TEXT = "start scaffolding philo mobile";
const TASK_TWO_TEXT = "polish landing page";
const DEMO_TICK_MS = 50;

function toLocalDateString(date: Date,): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1,).padStart(2, "0",)}-${
    String(date.getDate(),).padStart(2, "0",)
  }`;
}

function addDays(dateStr: string, days: number,): string {
  const date = new Date(`${dateStr}T00:00:00`,);
  date.setDate(date.getDate() + days,);
  return toLocalDateString(date,);
}

function getToday(): string {
  return toLocalDateString(new Date(),);
}

function ordinalSuffix(day: number,): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function formatDate(dateStr: string,): string {
  const date = new Date(`${dateStr}T00:00:00`,);
  const month = date.toLocaleDateString("en-US", { month: "long", },);
  const day = date.getDate();
  return `${month} ${day}${ordinalSuffix(day,)}`;
}

function formatMentionDate(dateStr: string,): string {
  return new Date(`${dateStr}T00:00:00`,).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  },);
}

function getTypedText(text: string, elapsed: number, start: number, stepMs: number,): string {
  if (elapsed < start) return "";
  const count = Math.min(text.length, Math.floor((elapsed - start) / stepMs,) + 1,);
  return text.slice(0, count,);
}

function useLoopingElapsed(durationMs: number,): number {
  const [elapsed, setElapsed,] = useState(0,);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsed((Date.now() - startedAt) % durationMs,);
    }, DEMO_TICK_MS,);

    return () => {
      window.clearInterval(timer,);
    };
  }, [durationMs,],);

  return elapsed;
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
      <path d="M5 2.5v2M11 2.5v2M2.5 6.5h11" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M3 11.75V13h1.25l6.55-6.55-1.25-1.25L3 11.75Z" />
      <path d="m8.9 5.2 1.25 1.25" />
      <path d="M10.4 3.7a.9.9 0 0 1 1.27 0l.63.63a.9.9 0 0 1 0 1.27l-.48.48-1.9-1.9.48-.48Z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M13 5.5V2.8h-2.7" />
      <path d="M13 2.8 9.7 6.1" />
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M3 4.5h10" />
      <path d="M6 4.5V3.4c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.1" />
      <path d="M4.3 4.5 5 13h6l.7-8.5" />
      <path d="M6.7 6.5v4.5M9.3 6.5v4.5" />
    </svg>
  );
}

function buildDemoState(elapsed: number, today: string,) {
  const tomorrow = addDays(today, 1,);

  const ideaStart = 400;
  const ideaEnd = ideaStart + IDEA_TEXT.length * 46;
  const taskOneStart = ideaEnd + 450;
  const taskOneTextEnd = taskOneStart + TASK_ONE_TEXT.length * 38;
  const taskOneMentionStart = taskOneTextEnd + 140;
  const taskOneMenuStart = taskOneMentionStart + 160;
  const taskOneSelect = taskOneMenuStart + 900;
  const taskTwoStart = taskOneSelect + 320;
  const taskTwoTextEnd = taskTwoStart + TASK_TWO_TEXT.length * 38;
  const taskTwoMentionStart = taskTwoTextEnd + 150;
  const taskTwoComplete = taskTwoMentionStart + 500;
  const buildEntryStart = taskTwoComplete + 850;
  const buildEntryEnd = buildEntryStart + BUILD_PROMPT.length * 38;
  const buildSelectionStart = buildEntryEnd + 350;
  const bubbleBuildStart = buildSelectionStart + 650;
  const widgetLoadingStart = bubbleBuildStart + 450;
  const widgetReadyStart = widgetLoadingStart + 1500;
  const loopEnd = widgetReadyStart + 2200;

  return {
    duration: loopEnd,
    ideaText: getTypedText(IDEA_TEXT, elapsed, ideaStart, 46,),
    showIdeaCaret: elapsed >= ideaStart && elapsed < ideaEnd,
    showTaskOne: elapsed >= taskOneStart,
    taskOneText: getTypedText(TASK_ONE_TEXT, elapsed, taskOneStart, 38,),
    taskOneMentionDraft: elapsed >= taskOneMentionStart && elapsed < taskOneSelect
      ? getTypedText(" @t", elapsed, taskOneMentionStart, 120,)
      : "",
    showTaskOneCaret: elapsed >= taskOneStart && elapsed < taskOneSelect,
    showMentionMenu: elapsed >= taskOneMenuStart && elapsed < taskOneSelect,
    taskOneChip: elapsed >= taskOneSelect ? "Today" : "",
    showTaskTwo: elapsed >= taskTwoStart,
    taskTwoText: getTypedText(TASK_TWO_TEXT, elapsed, taskTwoStart, 38,),
    taskTwoMentionDraft: elapsed >= taskTwoMentionStart && elapsed < taskTwoComplete
      ? getTypedText(" @tomorrow", elapsed, taskTwoMentionStart, 70,)
      : "",
    showTaskTwoCaret: elapsed >= taskTwoStart && elapsed < taskTwoComplete,
    taskTwoChip: elapsed >= taskTwoComplete ? formatMentionDate(tomorrow,) : "",
    showBuildArea: elapsed >= buildEntryStart,
    showBuildEntry: elapsed >= buildEntryStart && elapsed < widgetLoadingStart,
    buildEntryText: getTypedText(BUILD_PROMPT, elapsed, buildEntryStart, 38,),
    showBuildCaret: elapsed >= buildEntryStart && elapsed < buildSelectionStart,
    buildEntrySelected: elapsed >= buildSelectionStart && elapsed < widgetLoadingStart,
    showBubbleMenu: elapsed >= buildSelectionStart && elapsed < widgetLoadingStart,
    bubbleBuildPressed: elapsed >= bubbleBuildStart && elapsed < widgetLoadingStart,
    showWidgetLoading: elapsed >= widgetLoadingStart && elapsed < widgetReadyStart,
    showWidgetReady: elapsed >= widgetReadyStart,
  };
}

export default function ReadOnlyHeroNote() {
  const today = getToday();
  const baseDemo = useMemo(() => buildDemoState(0, today,), [today,],);
  const elapsed = useLoopingElapsed(baseDemo.duration,);
  const demo = useMemo(() => buildDemoState(elapsed, today,), [elapsed, today,],);

  return (
    <section className="hero-note-shell" aria-label="Animated Philo note demo">
      <div className="hero-note-titlebar" aria-hidden="true">
        <div className="hero-note-dots">
          <span />
          <span />
          <span />
        </div>
        <svg className="hero-note-pin" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z" />
        </svg>
      </div>

      <div className="hero-note-surface">
        <div className="hero-note-header">
          <p className="hero-note-date">{formatDate(today,)}</p>
          <span className="hero-note-pill">TODAY</span>
          <span className="hero-note-city">Seoul</span>
        </div>

        <div className="hero-note-editor" aria-hidden="true">
          <div className="hero-note-flow">
            <div className="hero-note-entry hero-note-entry-idea">
              <p className="hero-note-copy">
                {demo.ideaText}
                {demo.showIdeaCaret && <span className="hero-note-caret" />}
              </p>
            </div>

            {demo.showBuildArea && (
              <div className="hero-note-entry hero-note-entry-build">
                {demo.showBuildEntry && (
                  <div className="hero-note-build-line">
                    {demo.showBubbleMenu && (
                      <div className="hero-note-bubble-menu">
                        <button type="button" className="hero-note-bubble-btn">B</button>
                        <button type="button" className="hero-note-bubble-btn hero-note-bubble-btn-italic">I</button>
                        <button type="button" className="hero-note-bubble-btn hero-note-bubble-btn-strike">S</button>
                        <button type="button" className="hero-note-bubble-btn">{"</>"}</button>
                        <div className="hero-note-bubble-divider" />
                        <button type="button" className="hero-note-bubble-btn hero-note-bubble-btn-chat">Chat</button>
                        <button
                          type="button"
                          className={`hero-note-bubble-btn hero-note-bubble-btn-build${
                            demo.bubbleBuildPressed ? " is-building" : ""
                          }`}
                        >
                          {demo.bubbleBuildPressed ? "Building..." : "Build"}
                        </button>
                      </div>
                    )}
                    <p className="hero-note-copy">
                      {demo.buildEntrySelected ? <span className="hero-note-inline-selection">{BUILD_PROMPT}</span> : (
                        <>
                          {demo.buildEntryText}
                          {demo.showBuildCaret && <span className="hero-note-caret" />}
                        </>
                      )}
                    </p>
                  </div>
                )}

                {(demo.showWidgetLoading || demo.showWidgetReady) && (
                  <div className="hero-note-widget-shell">
                    <div className="hero-note-widget-toolbar">
                      <span className="hero-note-widget-prompt">Chest workout for today</span>
                      <div className="hero-note-widget-actions">
                        <span className="hero-note-widget-button">
                          <EditIcon />
                        </span>
                        <span className="hero-note-widget-button">
                          <RefreshIcon />
                        </span>
                        <span className="hero-note-widget-button hero-note-widget-button-delete">
                          <DeleteIcon />
                        </span>
                      </div>
                    </div>

                    {demo.showWidgetLoading && (
                      <div className="hero-note-widget-loading">
                        <div className="hero-note-widget-loading-inner">
                          <div className="hero-note-widget-spinner" />
                          <span className="hero-note-widget-loading-text">Sophia is building...</span>
                          <span className="hero-note-widget-loading-prompt">{BUILD_PROMPT}</span>
                        </div>
                      </div>
                    )}

                    {demo.showWidgetReady && (
                      <div className="hero-note-widget-render">
                        <div className="hero-note-widget-card">
                          <div className="hero-note-widget-card-header">
                            <div>
                              <p className="hero-note-widget-title">Push Day</p>
                              <p className="hero-note-widget-subtitle">Chest + triceps</p>
                            </div>
                            <span className="hero-note-chip hero-note-chip-today">Today</span>
                          </div>
                          <div className="hero-note-widget-set">
                            <span>Barbell bench press</span>
                            <strong>4 x 6</strong>
                          </div>
                          <div className="hero-note-widget-set">
                            <span>Incline dumbbell press</span>
                            <strong>3 x 10</strong>
                          </div>
                          <div className="hero-note-widget-set">
                            <span>Cable fly</span>
                            <strong>3 x 12</strong>
                          </div>
                          <div className="hero-note-widget-set">
                            <span>Dips</span>
                            <strong>2 x AMRAP</strong>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="hero-note-task-stack">
              {demo.showTaskOne && (
                <div className="hero-note-task">
                  <span className="hero-note-checkbox" />
                  <div className="hero-note-task-copy">
                    <p className="hero-note-copy">
                      {demo.taskOneText}
                      {demo.taskOneChip
                        ? (
                          <>
                            {" "}
                            <span className="hero-note-chip hero-note-chip-today">{demo.taskOneChip}</span>
                          </>
                        )
                        : (
                          demo.taskOneMentionDraft
                        )}
                      {demo.showTaskOneCaret && !demo.taskOneChip && <span className="hero-note-caret" />}
                    </p>

                    {demo.showMentionMenu && (
                      <div className="hero-note-mention-menu">
                        <div className="hero-note-mention-items">
                          <button type="button" className="hero-note-mention-item">
                            <span className="hero-note-mention-icon">
                              <CalendarIcon />
                            </span>
                            <span className="hero-note-mention-label">Select date</span>
                          </button>
                          <div className="hero-note-mention-divider" />
                          <button type="button" className="hero-note-mention-item is-selected">
                            <span className="hero-note-mention-icon">
                              <CalendarIcon />
                            </span>
                            <span className="hero-note-mention-label">Today</span>
                          </button>
                          <button type="button" className="hero-note-mention-item">
                            <span className="hero-note-mention-icon">
                              <CalendarIcon />
                            </span>
                            <span className="hero-note-mention-label">Tomorrow</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {demo.showTaskTwo && (
                <div className="hero-note-task">
                  <span className="hero-note-checkbox" />
                  <div className="hero-note-task-copy">
                    <p className="hero-note-copy">
                      {demo.taskTwoText}
                      {demo.taskTwoChip
                        ? (
                          <>
                            {" "}
                            <span className="hero-note-chip hero-note-chip-date">{demo.taskTwoChip}</span>
                          </>
                        )
                        : (
                          demo.taskTwoMentionDraft
                        )}
                      {demo.showTaskTwoCaret && !demo.taskTwoChip && <span className="hero-note-caret" />}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
