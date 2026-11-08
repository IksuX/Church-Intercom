// Wtyczka jest wołana ze strony interkomu przez window.Capacitor.Plugins.IkAudio – ten plik jest tylko dla porządku.
export const IkAudio = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.IkAudio : undefined;
