// Icons.jsx - tiny inline SVG icons (no icon library needed).
const Svg = ({ children, ...props }) => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    {children}
  </svg>
);

export const WaveIcon = () => (
  <Svg>
    <path d="M4 10v4" />
    <path d="M8 6v12" />
    <path d="M12 9v6" />
    <path d="M16 4v16" />
    <path d="M20 10v4" />
  </Svg>
);

export const UploadIcon = () => (
  <Svg>
    <path d="M12 15V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M5 20h14" />
  </Svg>
);

export const MusicIcon = () => (
  <Svg>
    <path d="M9 18V5l11-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="17" cy="16" r="3" />
  </Svg>
);

export const CopyIcon = () => (
  <Svg>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </Svg>
);

export const DownloadIcon = () => (
  <Svg>
    <path d="M12 4v11" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 20h14" />
  </Svg>
);

export const CheckIcon = () => (
  <Svg>
    <path d="m5 12 5 5 9-10" />
  </Svg>
);

export const AlertIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5" />
    <path d="M12 16.5h.01" />
  </Svg>
);

export const CloseIcon = () => (
  <Svg>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const SunIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const MoonIcon = () => (
  <Svg>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Svg>
);

export const AutoIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18" />
    <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
  </Svg>
);

export const SendIcon = () => (
  <Svg>
    <path d="M5 12h13" />
    <path d="m13 6 6 6-6 6" />
  </Svg>
);

export const PlayIcon = () => (
  <Svg>
    <path d="M7 4.5v15l12-7.5Z" />
  </Svg>
);

export const StopIcon = () => (
  <Svg>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
);

export const TrashIcon = () => (
  <Svg>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6 7l1 13h10l1-13" />
  </Svg>
);

export const MinusIcon = () => (
  <Svg>
    <path d="M6 12h12" />
  </Svg>
);
