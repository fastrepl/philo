import { useEffect, useState, } from "react";

export type DatePickerRecurrence = "" | "daily" | "weekly" | "monthly";

export const DATE_PICKER_RECURRENCE_OPTIONS: {
  value: DatePickerRecurrence;
  label: string;
}[] = [
  { value: "", label: "None", },
  { value: "daily", label: "Daily", },
  { value: "weekly", label: "Weekly", },
  { value: "monthly", label: "Monthly", },
];

function toIsoDate(date: Date,) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1,).padStart(2, "0",)}-${
    String(date.getDate(),).padStart(2, "0",)
  }`;
}

function fromIsoDate(date: string,) {
  return new Date(`${date}T00:00:00`,);
}

export function shiftIsoDate(date: string, days: number,) {
  const next = fromIsoDate(date,);
  next.setDate(next.getDate() + days,);
  return toIsoDate(next,);
}

export function shiftIsoMonth(date: string, months: number,) {
  const current = fromIsoDate(date,);
  const next = new Date(current.getFullYear(), current.getMonth() + months, 1,);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0,).getDate();
  next.setDate(Math.min(current.getDate(), lastDay,),);
  return toIsoDate(next,);
}

export function toggleDatePickerRecurrence(
  current: DatePickerRecurrence,
  next: Exclude<DatePickerRecurrence, "">,
): DatePickerRecurrence {
  return current === next ? "" : next;
}

export function handleDatePickerKeyDown({
  event,
  selectedDate,
  setSelectedDate,
  recurrence,
  setRecurrence,
  onSubmit,
  onClose,
}: {
  event: KeyboardEvent;
  selectedDate: string;
  setSelectedDate: (date: string,) => void;
  recurrence: DatePickerRecurrence;
  setRecurrence: (value: DatePickerRecurrence,) => void;
  onSubmit: () => void;
  onClose: () => void;
},) {
  if (event.key === "Escape") {
    event.preventDefault();
    onClose();
    return true;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    onSubmit();
    return true;
  }

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setSelectedDate(shiftIsoDate(selectedDate, -1,),);
    return true;
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    setSelectedDate(shiftIsoDate(selectedDate, 1,),);
    return true;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    setSelectedDate(shiftIsoDate(selectedDate, -7,),);
    return true;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setSelectedDate(shiftIsoDate(selectedDate, 7,),);
    return true;
  }

  if (event.key === "," || event.key === "<") {
    event.preventDefault();
    setSelectedDate(shiftIsoMonth(selectedDate, -1,),);
    return true;
  }

  if (event.key === "." || event.key === ">") {
    event.preventDefault();
    setSelectedDate(shiftIsoMonth(selectedDate, 1,),);
    return true;
  }

  const key = event.key.toLowerCase();
  if (key === "d") {
    event.preventDefault();
    setRecurrence(toggleDatePickerRecurrence(recurrence, "daily",),);
    return true;
  }

  if (key === "w") {
    event.preventDefault();
    setRecurrence(toggleDatePickerRecurrence(recurrence, "weekly",),);
    return true;
  }

  if (key === "m") {
    event.preventDefault();
    setRecurrence(toggleDatePickerRecurrence(recurrence, "monthly",),);
    return true;
  }

  if (key === "n") {
    event.preventDefault();
    setRecurrence("",);
    return true;
  }

  return false;
}

export function MiniCalendar({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (date: string,) => void;
},) {
  const todayStr = toIsoDate(new Date(),);
  const initialDate = selected ? fromIsoDate(selected,) : new Date();
  const [viewYear, setViewYear,] = useState(initialDate.getFullYear(),);
  const [viewMonth, setViewMonth,] = useState(initialDate.getMonth(),);

  useEffect(() => {
    const next = selected ? fromIsoDate(selected,) : new Date();
    setViewYear(next.getFullYear(),);
    setViewMonth(next.getMonth(),);
  }, [selected,],);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0,).getDate();
  const daysInPreviousMonth = new Date(viewYear, viewMonth, 0,).getDate();
  const firstDay = (new Date(viewYear, viewMonth, 1,).getDay() + 6) % 7;
  const cells: { day: number; monthOffset: -1 | 0 | 1; }[] = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({ day: daysInPreviousMonth - i, monthOffset: -1, },);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ day, monthOffset: 0, },);
  }
  while (cells.length % 7 !== 0) {
    cells.push({ day: cells.length - (firstDay + daysInMonth) + 1, monthOffset: 1, },);
  }

  const toCellIso = (day: number, monthOffset: -1 | 0 | 1,) => {
    return toIsoDate(new Date(viewYear, viewMonth + monthOffset, day,),);
  };

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewYear((year,) => year - 1);
      setViewMonth(11,);
      return;
    }
    setViewMonth((month,) => month - 1);
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewYear((year,) => year + 1);
      setViewMonth(0,);
      return;
    }
    setViewMonth((month,) => month + 1);
  };

  const title = new Date(viewYear, viewMonth, 1,).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  },);

  return (
    <div className="mention-calendar">
      <div className="mention-calendar-header">
        <button className="mention-calendar-nav" onClick={prevMonth} type="button">‹</button>
        <span className="mention-calendar-title">{title}</span>
        <button className="mention-calendar-nav" onClick={nextMonth} type="button">›</button>
      </div>
      <div className="mention-calendar-weekdays">
        {["M", "T", "W", "T", "F", "S", "S",].map((day, index,) => (
          <span key={index} className="mention-calendar-weekday">{day}</span>
        ))}
      </div>
      <div className="mention-calendar-grid">
        {cells.map(({ day, monthOffset, }, index,) => {
          const iso = toCellIso(day, monthOffset,);
          return (
            <button
              key={index}
              className={`mention-calendar-cell${iso === todayStr ? " is-today" : ""}${
                iso === selected ? " is-selected" : ""
              }${monthOffset !== 0 ? " is-outside-month" : ""}`}
              onClick={() => onSelect(iso,)}
              type="button"
            >
              {day}
            </button>
          );
        },)}
      </div>
    </div>
  );
}
