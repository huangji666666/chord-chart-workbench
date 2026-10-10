import { createElement, Music2, LibraryBig, NotebookPen, Mic2, Upload, Download, Plus, Search, Star, Folder, ListMusic, MoreHorizontal, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, Play, Pause, Square, Repeat2, Volume2, SlidersHorizontal, Undo2, Redo2, Check, Sparkles, Trash2, FileText, Palette, Copy, Maximize, X, Guitar, Timer, Menu, ArrowUpRight } from 'lucide';

const icons = { music: Music2, library: LibraryBig, edit: NotebookPen, stage: Mic2, upload: Upload, download: Download, plus: Plus, search: Search, star: Star, folder: Folder, setlist: ListMusic, more: MoreHorizontal, left: ChevronLeft, right: ChevronRight, up: ArrowUp, down: ArrowDown, play: Play, pause: Pause, stop: Square, repeat: Repeat2, volume: Volume2, settings: SlidersHorizontal, undo: Undo2, redo: Redo2, check: Check, sparkle: Sparkles, trash: Trash2, file: FileText, palette: Palette, copy: Copy, fullscreen: Maximize, close: X, guitar: Guitar, timer: Timer, menu: Menu, arrow: ArrowUpRight };

export function icon(name, size = 18) {
  return createElement(icons[name] ?? Music2, { width: String(size), height: String(size), 'stroke-width': '1.7', 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}

export function withIcon(button, name, size = 18) {
  button.prepend(icon(name, size));
  return button;
}
