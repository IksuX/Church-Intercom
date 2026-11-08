# Interkom 0.44.6

Hybrydowy interkom dla ekip nabożeństwa: kanały, czat, szybkie przyciski i mówienie przez przycisk (push-to-talk). Działa w przeglądarce na telefonie, tablecie i komputerze, bez instalowania aplikacji. Serwer stoi lokalnie, więc internet nie jest potrzebny w trakcie nabożeństwa.

## Co jest w tej wersji

- **Kanały** (Ogólny, Technika, Uwielbienie, Kamery, Powitanie, Dzieci). Listę zmieniasz w `config/config.json`. Każdy sam wybiera, których kanałów słucha.
- **Czat tekstowy** na każdym kanale. Wiadomości z innych słuchanych kanałów pokazują się jako powiadomienie u góry ekranu i jako licznik na zakładce.
- **Szybkie przyciski:** OK, Gotowe, Czekam, Następny punkt, Potrzebuję pomocy, PILNE! PILNE daje sygnał dźwiękowy, wibrację i czerwony alert.
- **Push-to-talk** dla osób z PIN-em mówiącego. Przytrzymaj przycisk, żeby mówić. 🔒 włącza mikrofon na stałe, a na komputerze działa też spacja. Mówisz do kanału, który masz otwarty.
- **Głos trafia tylko do osób, które słuchają danego kanału.** Serwer w ogóle nie wysyła dźwięku pozostałym.
- **Transkrypcja mowy (nowość w 0.2):** po każdej wypowiedzi w czacie pojawia się wpis „🎙 Anna mówiła 4 s”, a 1–3 s później jego treść jako tekst. Głos na żywo idzie osobnym torem i transkrypcja go nie opóźnia. Rozpoznawanie działa lokalnie (Whisper), nagrania nie opuszczają serwera.
- **Czytanie wiadomości na głos (TTS)** przez syntezę mowy wbudowaną w telefon lub komputer. Włączasz je w ⚙️.
- **Ekran nie gaśnie** w trakcie pracy. Aplikacja sama łączy się ponownie po utracie Wi-Fi.
- **Administrator** może wyczyścić czat przed kolejnym nabożeństwem. Historia każdego dnia zapisuje się w `data/app/log/`.

## Wymagania

- Mini PC z Intel N100/N150, 16 GB RAM, SSD, podłączony **kablem** do sieci.
- **Ubuntu Server 24.04 LTS** z włączonym OpenSSH.
- **Stały adres IP** serwera, ustawiony jako rezerwacja DHCP w routerze.
- Telefony i komputery ekip w tej samej sieci co serwer.

## Instalacja

1. Skopiuj folder na serwer, np.: `scp interkom-0.44.6.zip user@IP_SERWERA:~`
2. Na serwerze:
   ```bash
   sudo apt install -y unzip
   unzip interkom-0.44.6.zip && cd interkom
   sudo ./install.sh
   ```
3. Instalator zainstaluje Dockera i zada dwa pytania. Na końcu wypisze adres i PIN-y.

### Tryb 1: domena w Cloudflare (zalecany)

Na telefonach nic nie trzeba instalować. Potrzebujesz:
- domeny, której DNS jest w Cloudflare (może to być subdomena, np. `interkom.parafia.pl`);
- tokenu API: Cloudflare → My Profile → API Tokens → *Create Token* → szablon **Edit zone DNS**, ograniczony do tej strefy;
- rekordu **A** `interkom.parafia.pl → IP serwera w LAN` z **wyłączonym proxy** (szara chmurka, „DNS only”).

Certyfikat Let's Encrypt odnawia się sam. Serwer nadal jest dostępny tylko z sieci lokalnej.

> Niektóre routery blokują domeny wskazujące na adresy lokalne (tzw. ochrona przed DNS rebinding, np. FRITZ!Box, OpenWrt). Jeśli adres się nie otwiera, dodaj domenę do wyjątków w ustawieniach DNS routera.

### Tryb 4: darmowa subdomena DuckDNS (od 0.33.1)

Działa jak tryb 1 (prawdziwy certyfikat, nic do instalowania na telefonach, logowanie przez Planning Center), ale bez kupowania domeny:
1. Na https://www.duckdns.org zaloguj się, dodaj subdomenę (np. `interkom-cme`) i skopiuj **token**.
2. `sudo ./install.sh --reconfigure` → wybierz **4**, podaj subdomenę i token.

Instalator sam ustawia w DuckDNS **adres serwera w sieci lokalnej** (np. 192.168.1.171) i aktualizuje go przy każdym uruchomieniu. Interkom działa tylko w Wi-Fi kościoła, a z internetu nic nie jest widoczne. Certyfikat Let's Encrypt jest wydawany przez rekord DNS, więc serwer nie musi być dostępny z zewnątrz.

### Tryb 2: sam adres IP (bez domeny)

Serwer używa własnego certyfikatu, który **każde urządzenie musi raz zaufać**:
- **Android:** otwórz `http://IP_SERWERA/ca.crt`, potem Ustawienia → Bezpieczeństwo → Szyfrowanie i dane logowania → Zainstaluj certyfikat → Certyfikat CA.
- **iPhone/iPad:** otwórz `http://IP_SERWERA/ca.crt` w Safari → Ustawienia → Pobrano profil → Zainstaluj. Potem Ustawienia → Ogólne → To urządzenie → Ustawienia zaufania certyfikatów → włącz „Interkom/Caddy Local Authority”.
- **Windows:** otwórz plik → Zainstaluj certyfikat → Komputer lokalny → „Zaufane główne urzędy certyfikacji”.
- **macOS:** otwórz plik w Pęku kluczy → System → ustaw „Zawsze ufaj”.

### Tryb 3: test na wirtualnej maszynie w chmurze (VPS)

Służy do wypróbowania aplikacji, zanim przyjdzie sprzęt. Nie potrzebujesz domeny ani instalowania certyfikatów.

1. Załóż najmniejszą maszynę z **Ubuntu 24.04** i publicznym adresem IPv4 (np. Hetzner Cloud, DigitalOcean, OVH). Do testów wystarczą 2 vCPU i 2–4 GB RAM. Maszyny są rozliczane godzinowo, więc po teście po prostu ją usuń.
2. W zaporze dostawcy (jeśli jest włączona) otwórz porty **80/tcp, 443/tcp, 7881/tcp i 7882/udp**.
3. Zaloguj się przez SSH, wgraj paczkę i uruchom `sudo ./install.sh`. Wybierz **3** i naciśnij Enter przy pytaniu o domenę.
4. Aplikacja będzie pod adresem w rodzaju `https://1-2-3-4.sslip.io`, z prawdziwym certyfikatem Let's Encrypt. Zadziała na każdym telefonie, także przez LTE.

Opóźnienie głosu przez internet będzie większe niż w sieci lokalnej, zwykle 100–250 ms, zależnie od odległości od serwerowni.

## Aktualizacje z GitHuba

Kod jest w prywatnym repozytorium [IksuX/Church-Intercom](https://github.com/IksuX/Church-Intercom); każda wersja to zmiana opisana „Interkom X.Y.Z”. Serwer pobiera z niego program przez **klucz wdrożeniowy tylko do odczytu** – serwer nie może niczego zmienić w repozytorium.

**Jednorazowo, na serwerze** (zamiast rozpakowywania paczki zip):
```bash
sudo apt install -y git
ssh-keygen -t ed25519 -N "" -f ~/.ssh/interkom_github -C "serwer interkomu"
cat ~/.ssh/interkom_github.pub      # wklej w GitHub: repozytorium → Settings → Deploy keys → Add (bez „Allow write access”)
printf 'Host github.com\n  IdentityFile ~/.ssh/interkom_github\n  IdentitiesOnly yes\n' >> ~/.ssh/config
cd ~ && mv interkom interkom-zip-stary
git clone git@github.com:IksuX/Church-Intercom.git interkom
cp -a interkom-zip-stary/caddy/sites/. interkom/caddy/sites/ 2>/dev/null || true   # strony innych aplikacji
cd interkom && sudo ./install.sh
```
Ustawienia (`/var/lib/interkom`: `.env`, konfiguracja, dane) zostają – instalator sam je podłączy. Gdy wszystko działa, folder `interkom-zip-stary` można usunąć.

**Aktualizacja:** w panelu → **Serwer → Aktualizacje** („Sprawdź aktualizacje”, „Aktualizuj teraz”), albo na serwerze:
```bash
cd ~/interkom && ./update.sh            # najnowsza wersja
./update.sh --check                     # tylko sprawdź, co nowego
./update.sh 0.44.0                      # konkretna wersja (powrót do poprzedniej)
```
Ręczne zmiany w plikach programu są przed aktualizacją zapisywane do `zmiany-lokalne-*.patch`. Własne pliki `caddy/sites/*.caddy` nie są w repozytorium i zostają.

## Powiadomienia na zablokowanym ekranie (od 0.9.1)

Gdy aplikacja jest w tle albo telefon jest zablokowany, **wezwania**, **wiadomości prywatne** i **PILNE!** przychodzą jako powiadomienia systemowe. Wezwanie, które przyszło w tym czasie, pokazuje się na pełnym ekranie po otwarciu aplikacji (do 90 s).

- **iPhone / iPad (iOS 16.4+):** w Safari *Udostępnij → Do ekranu początkowego*, otwórz interkom z ikony, zaloguj się, potem ⚙️ → **🔔 Włącz powiadomienia** i zezwól. W przeglądarce Safari (bez ikony na ekranie) iOS na to nie pozwala.
- **Android / komputer:** ⚙️ → **🔔 Włącz powiadomienia**.
- Przycisk **Wyślij test** wysyła próbne powiadomienie po 5 s, żeby można było zablokować telefon.
- Serwer musi mieć dostęp do internetu, bo powiadomienia idą przez usługi Apple i Google. Dźwięk jest systemowy, a tryb „Skupienie” lub „Nie przeszkadzać” może je wyciszyć.

## Rozmowy prywatne i szept (od 0.9)

- W „Kto jest online” stuknij osobę i wybierz **💬 Napisz**. Rozmowa pojawia się jako zakładka ze zdjęciem obok kanałów, z licznikiem nieprzeczytanych i powiadomieniem. Zamkniesz ją ✕; nowa wiadomość otworzy ją ponownie.
- Działają tekst, szybkie przyciski i **szept**: osoba z prawem mówienia, mając otwartą rozmowę prywatną, trzyma przycisk mówienia, a słyszy ją tylko ta jedna osoba. Szept ma wpis i transkrypcję w rozmowie prywatnej.
- Serwer wysyła wiadomości prywatne wyłącznie do dwóch uczestników. Nie widzi ich administrator, nie trafiają do dziennika na dysku i znikają przy czyszczeniu czatu.
- Dla osób z Planning Center rozmowa przetrwa ponowne logowanie i zmianę telefonu. Dla zalogowanych PIN-em trwa do wylogowania.

## Wezwania, uprawnienia i informacje o kanałach (od 0.8)

- **Wezwanie osoby:** w „Kto jest online” stuknij osobę, wpisz opcjonalnie krótką wiadomość i kliknij **📣 Wezwij**. U tej osoby na cały ekran pojawia się czerwone wezwanie z sygnałem, wibracją i odczytem głosowym oraz przyciskami **✓ Idę** / **Nie teraz**. Odpowiedź wraca do wzywającego. Wezwanie nie trafia na ogólny czat.
- **Uprawnienia z panelu:** w zakładce **Stan** przy każdej osobie online ustawiasz **Mówienie** i **Sterowanie planem**: Auto (według grafiku lub PIN-u), Tak – zawsze albo Nie – nigdy. Zmiana działa od razu: przycisk mówienia pojawia się lub znika bez ponownego logowania. Dla osób z Planning Center ustawienie zapisuje się na stałe (lista „Zapisane uprawnienia”, z przyciskiem powrotu do auto), a dla zalogowanych PIN-em trwa do wylogowania.
- **Kto dołączył / opuścił:** na kanałach pojawiają się szare linijki „➕ … dołączył(a)”, „➖ … opuścił(a) kanał” i „⏏ … rozłączył(a) się”. Rozłączenie jest pokazywane dopiero po 30 s bez powrotu, bo telefony często na chwilę gubią Wi-Fi.

## Panel administracyjny

**Administrator zalogowany przez Planning Center** (od 0.10.1):
- w aplikacji: ⚙️ → **Uprawnienia** → wpisz PIN administratora. Zachowujesz swoje logowanie, zespoły i kanały;
- na stałe: w panelu, w zakładce Stan, kolumna **Administrator → Tak – na stałe** przy wybranej osobie. Każde jej logowanie przez Planning Center daje od razu dostęp do panelu;
- panel (link w ⚙️) otwiera się wtedy bez ponownego wpisywania PIN-u.

Wszystko skonfigurujesz w przeglądarce, bez SSH: **https://twój-adres/admin**. Logujesz się PIN-em administratora. W interkomie administrator ma też link do panelu w ⚙️. Zmiany działają od razu u wszystkich, bez restartu.

- **Stan:** kto jest online i czego słucha, czy działa transkrypcja i Planning Center; czyszczenie czatu.
- **Ogólne:** nazwa, PIN-y, słownictwo dla rozpoznawania mowy.
- **Kanały:** dodawanie, nazwy, kolory, kolejność, wybór kanału ogólnego.
- **Szybkie przyciski:** napisy, kolory, alarm, kolejność (maks. 12).
- **Planning Center:** podłączenie tokenu z testem, wybór planu, typy wydarzeń, kto może mówić (liderzy, całe zespoły, stanowiska), przypisanie zespołów do kanałów (także kilku zespołów do jednego wspólnego kanału) i podgląd obsady.

Token Planning Center podany w panelu zapisuje się w `config/secrets.json` i ma pierwszeństwo przed tym z `.env`.

## Konfiguracja (ręcznie)

Plik `config/config.json`:
- `accessPin`: PIN, którym loguje się cała ekipa.
- `speakerPin`: PIN osób, które mogą mówić.
- `adminPin`: PIN administratora. Wpisuje się go w pole „PIN mówiącego”.
- `channels`: lista kanałów. `id` może zawierać tylko małe litery, cyfry, `-` i `_`. Kanał z `"broadcast": true` jest domyślny dla wszystkich.
- `quick`: szybkie przyciski. `tone` to kolor: `ok`, `wait`, `info`, `warn` lub `urgent`. `"urgent": true` włącza alarm.

Po zmianie: `sudo docker compose restart app`

## Planning Center

Po podłączeniu interkom:
- **pokazuje plan nabożeństwa**: pasek „▶ Teraz / Następnie” u góry i pełną listę punktów po jego dotknięciu. Gdy prowadzący przełącza punkty w **Planning Center Live**, pasek przesuwa się u wszystkich w ciągu kilku sekund. Bez Live punkt może ustawić ręcznie osoba mówiąca lub administrator, dotykając go na liście;
- **loguje kontem Planning Center** (patrz niżej). Goście i zastępstwa logują się PIN-em ekipy i wpisują imię. Od 0.10 nie ma już wybierania siebie z listy obsady, bo łatwo było wybrać kogoś innego;
- **przypisuje kanały według zespołów**: osoba z zespołu „Kamery” od razu słucha kanału Kamery i kanału ogólnego;
- **nadaje prawo mówienia** liderom zespołów i osobom na wybranych stanowiskach (`speakerPositions`). Pozostali mogą je dostać, wpisując PIN mówiącego;
- **tworzy kanały z zespołów**. Zespół o tej samej nazwie co istniejący kanał jest z nim łączony, a pozostałe dostają nowe kanały.

### Plan, notatki i sterowanie Live (od 0.5)

- Pasek u góry pokazuje **TERAZ** i **DALEJ** z tonacją i tempem. Po dotknięciu otwiera się karta bieżącego i następnego punktu, a pod nią cały plan. Przy punktach widać aranżację, BPM, metrum, sekwencję (I V1 C V2 C B…), notatki aranżacji (np. solówki) i notatki do punktów z Planning Center (np. „Audio”, „Światła”). Notatki Twojego zespołu są wyróżnione.
- **Sterowanie Live:** w panelu (Planning Center → „Sterowanie Planning Center Live”) wybierasz stanowiska lub zespoły, które mogą przełączać punkty. Osoby te widzą przyciski ◀ ▶ na pasku planu, a dotknięcie punktu na liście przełącza Live na ten punkt. Interkom przejmuje wtedy sterowanie Live od osoby prowadzącej je na komputerze. Właściciel tokenu musi być Editorem lub Administratorem w Services.

### Logowanie kontem Planning Center (od 0.6)

Na ekranie logowania pojawia się przycisk **„Zaloguj przez Planning Center”**. Po zalogowaniu interkom wie na pewno, kim jest dana osoba: sam dobiera jej kanały i prawo mówienia z grafiku, a nikt nie wybierze cudzego imienia. Logowanie PIN-em działa nadal, dla gości i zastępstw.

Konfiguracja (panel → Planning Center → „Logowanie przez Planning Center”):
1. Na https://api.planningcenteronline.com/oauth/applications w sekcji **OAuth Applications** kliknij **New Application**.
2. Jako Callback / Redirect URI wklej adres pokazany w panelu (`https://twój-adres/auth/pco/callback`).
3. Skopiuj **Client ID** i **Secret** do panelu, włącz przycisk i zapisz.

Opcja „tylko osoby z obsady” wpuszcza przez Planning Center wyłącznie osoby zaplanowane w bieżącym planie. Konta z innych organizacji są zawsze odrzucane. Logowanie wymaga internetu na telefonie tylko w chwili logowania, a sesja trwa 24 h.

Prawo mówienia i zespoły liczą się na bieżąco z grafiku, więc zmiana w Planning Center działa po ponownym otwarciu aplikacji, bez ponownego logowania.

### Ogłaszanie zmiany punktu (od 0.7.1)

Każda zmiana bieżącego punktu (w Planning Center Live, z interkomu lub ręczna) pojawia się na kanale ogólnym jako wpis „▶ TERAZ … / Następnie …” z tonacją i tempem. Syntezator mowy czyta go na głos: „Teraz: Kazanie. Następnie: Pieśń…”. Każdy może wyłączyć czytanie u siebie w ⚙️ („Czytaj na głos zmianę punktu planu”), a administrator może wyłączyć ogłoszenia dla wszystkich w panelu (Planning Center → Plan nabożeństwa).

### Zdjęcia profilowe (od 0.7)

Przy wiadomościach, wpisach głosowych i na liście osób widać zdjęcia z Planning Center, a u osób bez zdjęcia lub zalogowanych PIN-em kolorowe kółko z inicjałami. Zdjęcia zapisują się na serwerze (`data/app/avatars`), więc działają też bez internetu. Odświeżają się raz na dobę i są widoczne tylko dla zalogowanych.

### Podłączenie

1. Zaloguj się do Planning Center i otwórz https://api.planningcenteronline.com/oauth/applications
2. W sekcji **Personal Access Tokens** kliknij **Create one now**, nazwij go np. „Interkom” i zostaw dostęp do **Services**. Token ma uprawnienia osoby, która go tworzy, więc najlepiej, żeby zrobił to ktoś z dostępem administratora do Services.
3. Na serwerze: `sudo bash install.sh --pco` i wklej **Application ID** oraz **Secret**.
4. Instalator sprawdzi połączenie i wypisze typy nabożeństw, zespoły, dzisiejszą obsadę i nazwy stanowisk.

Gdy nie ma internetu, interkom działa dalej na ostatnio pobranym planie.

### Ustawienia (`config/config.json` → `"planningCenter"`)

| Pole | Znaczenie |
|---|---|
| `serviceTypeIds` | ID typów nabożeństw do uwzględnienia (puste = wszystkie). ID pokaże polecenie sprawdzające poniżej. |
| `speakerPositions` | Stanowiska z prawem mówienia (fragment nazwy, np. `"Reżyser"`). |
| `speakerTeams` | Całe zespoły z prawem mówienia, np. `["Realizacja"]`. |
| `teamLeadersCanSpeak` | Czy liderzy zespołów mogą mówić (domyślnie tak). |
| `teamChannels` | Czy tworzyć kanały z zespołów (domyślnie tak). |
| `teamChannelMap` | Ręczne łączenie, np. `{"Zespół techniczny": "technika"}`. |

Po zmianach: `sudo docker compose restart app`. Sprawdzenie danych: `sudo docker compose exec app node src/pco-check.js`

Administrator może w ⚙️ wybrać inny plan niż automatycznie wskazany (dzisiejszy lub najbliższy) i wymusić odświeżenie danych.

## Rozpoznawanie mowy

- **Gdzie działa** (od 0.10): w panelu (Transkrypcja) zaznaczasz kanały z transkrypcją i to, czy działa w rozmowach prywatnych. Na pozostałych kanałach nagrania w ogóle nie są wysyłane do rozpoznawania.
- **Co widzi użytkownik:** w ⚙️ każdy wybiera „Pokazuj zawsze”, „Tylko gdy mam wyłączony głos” albo „Nie pokazuj”.
- **Niepewne fragmenty:** gdy model nie był pewny, tekst jest szary, oznaczony „≈ … (niepewne)”. Whisper w takich miejscach potrafi „dopowiedzieć” sensownie brzmiące słowa, które zmieniają sens.

- Model wybierasz w panelu (**Transkrypcja**). Zmiana działa od razu: nowy model ładuje się w tle, a do tego czasu działa poprzedni. Przy pierwszym użyciu model pobiera się z internetu, potem działa offline.
  - `base`: szybki; domyślny na słabych serwerach (≤ 2 rdzenie, np. VPS).
  - `small`: dobra jakość; domyślny na mini PC z N100/N150 i mocniejszych.
  - `medium`: najlepsza jakość, wolny, ok. 2,5 GB RAM.
- Panel pokazuje średnią szybkość (np. „0,4× czasu mowy” oznacza 4 s mowy w 1,6 s). Przycisk „Test szybkości” przepuszcza ostatnią wypowiedź przez wybrany model.
- W tym samym miejscu możesz dodać krótkie zdanie z rzadkimi słowami, które model myli. Nie wpisuj długich list imion: model zaczyna je wtedy powtarzać zamiast słuchać. Zapętlenia są wykrywane automatycznie; wtedy transkrypcja jest powtarzana bez podpowiedzi.
- `medium` na słabym serwerze jest bardzo wolny (np. 27 s na 6 s mowy na VPS z 2 rdzeniami).
- Podgląd pracy: `sudo docker compose logs -f stt`.

## Obsługa

| Czynność | Polecenie (w folderze `interkom`) |
|---|---|
| Stan | `sudo docker compose ps` |
| Logi | `sudo docker compose logs -f app livekit` |
| Restart | `sudo docker compose restart` |
| Aktualizacja do nowej wersji | `unzip -o interkom-X.zip`, potem `cd interkom && sudo ./install.sh`. Ustawienia, PIN-y i klucze zostają (są w `/var/lib/interkom`), więc można też rozpakować do nowego folderu |
| Zmiana trybu/domeny | `sudo ./install.sh --reconfigure` |

Porty w sieci lokalnej: 80, 443 (aplikacja), 7881/tcp i 7882/udp (głos).

## Wskazówki na nabożeństwo

- Najlepsze są **słuchawki przewodowe**. Bluetooth dodaje 150–250 ms opóźnienia.
- **iPhone:** po zablokowaniu ekranu Safari wstrzymuje dźwięk. Zostaw aplikację na wierzchu, a ekran i tak nie zgaśnie. Dodanie do ekranu początkowego (Udostępnij → Do ekranu początkowego) daje widok pełnoekranowy.
- Wszystkie urządzenia powinny być w **jednej sieci Wi-Fi 5 GHz dla ekip**, najlepiej oddzielonej od Wi-Fi dla wiernych.
- Jeśli pojawi się pasek „Dotknij, aby włączyć dźwięk”, dotknij go. Przeglądarki wymagają jednego dotknięcia przed odtwarzaniem.
- Kropka w lewym górnym rogu: zielona oznacza, że tekst i głos działają; żółta, że działa tylko tekst; czerwona, że nie ma połączenia.

## Plan dalszych wersji

- **0.4:** synteza mowy na serwerze (Piper), z jednakowym polskim głosem na każdym urządzeniu. Wezwanie konkretnej osoby.
- Później ewentualnie nakładka iOS, żeby dźwięk działał przy zablokowanym ekranie.

## Gdy transkrypcja się nie udaje

Pod wiadomością głosową widać powód, np. „złe nagranie z telefonu: … [audio/mp4, 0.3 kB]” (problem po stronie nagrania w przeglądarce) albo „błąd modelu: …” (problem serwera transkrypcji).

- Szczegóły: `sudo docker compose logs --tail=50 stt`
- 10 ostatnich nieudanych nagrań trafia do `data/stt-models/failed/` – można je odsłuchać.
- Od 0.10.2 nagranie startuje dopiero po włączeniu mikrofonu, co usuwa puste nagrania na iPhonie po wygaszeniu ekranu.
- Od 0.10.3 serwer transkrypcji ma własny dekoder dźwięku, a biblioteka PyAV ma przypiętą wersję. Nowsza PyAV psuła odczyt każdego nagrania („open() got an unexpected keyword argument 'metadata_errors'”).

## Transkrypcja długich wypowiedzi (kłódka)

Od 0.11.0 telefon w trakcie nadawania śledzi głośność mówiącego i dzieli wypowiedź na fragmenty w naturalnych przerwach. Każdy fragment trafia do transkrypcji od razu, a głos na żywo leci bez przerwy. Na czacie fragmenty mają dopisek „(fragment)”.

- Cięcie następuje po przerwie ≥ 0,7 s, gdy fragment ma co najmniej 4 s.
- Po 18 s wystarczy przerwa 0,3 s.
- Po 30 s cięcie następuje zawsze.
- Gdy kłódka jest włączona, a nikt nie mówi, nie powstają puste wpisy.

## Powiadomienia o transmisji live (Web Presenter + YouTube / Facebook)

Działają dwa źródła informacji:

- **Web Presenter HD / 4K** (protokół Ethernet, TCP 9977) mówi, czy sygnał dociera do platformy (podgląd) i czy łącze nadąża.
- **YouTube / Facebook** mówią, czy transmisja jest naprawdę **publiczna**, czyli czy kliknięto „Rozpocznij transmisję” w YouTube Studio albo „Transmituj na żywo” w Facebook Live Producer. Od 0.13.0 Interkom sprawdza to w API platform.

Komunikaty na czacie (czytane na głos):

- 📡 sygnał dociera (podgląd), transmisja czeka na uruchomienie;
- 🔴 **transmisja na żywo wystartowała** – tylko wtedy, gdy jest już publiczna;
- ⏹ transmisja zakończona;
- ⚠️ problemy:
  - sygnał przerwany;
  - słabe łącze;
  - brak kontaktu z urządzeniem;
  - „Web Presenter przestał nadawać, a transmisja nadal trwa”.

W nagłówku aplikacji znaczek pokazuje **◌ PODGLĄD** (szary) albo **● LIVE** (czerwony).

Konfiguracja jest w panelu, w zakładce **Transmisja**:

1. Urządzenia: nazwa, adres IP, platforma (YouTube / Facebook). Tryb „W sieci kościoła” albo „W chmurze” (wtedy z mostkiem, patrz niżej).
2. **YouTube:** w Google Cloud utwórz klienta OAuth typu *TVs and Limited Input devices* z włączonym YouTube Data API v3. Dostęp jest tylko do odczytu. Połącz kodem wpisanym na google.com/device. Opublikuj aplikację w *OAuth consent screen*, bo inaczej połączenie wygasa po 7 dniach.
3. **Facebook:** potrzebujesz aplikacji na developers.facebook.com (wystarczy tryb deweloperski) oraz tokenu z Graph API Explorer (*pages_show_list*, *pages_read_engagement*). Potem wybierz stronę. Interkom zapisuje stały token strony.

Szczegółowe instrukcje krok po kroku są w panelu.

Bez połączonej platformy Interkom ogłasza tylko to, co wie: że Web Presenter zaczął i przestał nadawać.

**Serwer w chmurze (VPS):** Web Presentery stoją w sieci kościoła, więc stan przekazuje mostek. W panelu wygeneruj token i uruchom podane polecenie (Docker albo Node.js 18+) na komputerze w kościele. Mostek łączy się tylko wychodząco.

## Kolumny z Planning Center w powiadomieniach

Każda osoba wybiera w ustawieniach, które kolumny notatek z planu (np. Audio, Światła, Wideo) mają się pojawiać przy zmianie punktu. Te notatki są widoczne:

- w ogłoszeniu na czacie;
- w lektorze;
- na pasku planu.

Opcja „Automatycznie” pokazuje kolumny o nazwach zespołów tej osoby z grafiku.

## Widok podzielony

Na szerokim ekranie (tablet poziomo, komputer, od 900 px) plan Planning Center jest stale widoczny z boku, a komunikacja obok. W ustawieniach można wybrać:

- automatycznie;
- plan po lewej;
- plan po prawej;
- jeden panel.

## Jakość transkrypcji (od 0.14.0)

- **Nagrywanie:** telefon nagrywa z własnej kopii mikrofonu, z buforem 0,6 s sprzed wciśnięcia przycisku i 0,45 s po puszczeniu. Wysyła czysty WAV 16 kHz. Pierwsze i ostatnie słowa nie są ucinane, nawet gdy włączenie mikrofonu chwilę trwa.
- **Model:** nowy *large-v3-turbo* – najlepszy polski. Potrzebuje ok. 2 GB RAM, sensownie działa od 4 rdzeni.
- **Dokładność:** do wyboru szybko / zrównoważona / dokładnie (1, 3 lub 5 wariantów dekodowania).
- **Przygotowanie dźwięku:** cisza nie trafia do modelu, cichy mówca jest wzmacniany, na brzegach dodawany jest margines ciszy.
- **Zmyślenia** („Dziękuję za uwagę”, napisy z YouTube, powtórzenia) są usuwane fragmentami. Reszta wypowiedzi zostaje.
- **Słownik:** imiona, nazwy, tytuły pieśni. Do tego automatycznie tytuły z bieżącego planu Planning Center, a opcjonalnie imiona z grafiku.
- **Ostatnie nagrania:** w panelu (Ogólne) jest 20 ostatnich wypowiedzi do odsłuchu i porównania. „Ponów” transkrybuje nagranie jeszcze raz bieżącymi ustawieniami. Nagrania są tylko w pamięci i znikają przy czyszczeniu czatu.

Jak dobrać ustawienia: nagraj kilka typowych komunikatów, potem zmieniaj model, dokładność i słownik, i porównuj wyniki przyciskiem „Ponów”. Czas transkrypcji widać przy każdym wyniku.

## Wybór mikrofonu i głośnika (od 0.15.0)

W ustawieniach aplikacji (⚙️), w sekcji **Dźwięk**, każdy wybiera u siebie:

- **mikrofon** – ze wskaźnikiem poziomu. Zmiana działa od razu i mikrofon zostaje wyciszony, dopóki nie wciśniesz przycisku;
- **przetwarzanie mikrofonu**: redukcja echa, redukcja szumów, automatyczne wzmocnienie. Wyłącz je przy sygnale z miksera albo dobrym mikrofonie zewnętrznym;
- **głośnik / słuchawki** – na komputerach i Androidzie. Na iPhonie i iPadzie wyjście wybiera się w Centrum sterowania (AirPlay), bo przeglądarka tego nie pozwala;
- **głośność rozmów** i **test głośnika**.

Wybór jest zapamiętywany na danym urządzeniu. Gdy zapamiętany mikrofon zniknie (np. odłączone słuchawki), aplikacja użyje domyślnego. Lektor (czytanie wiadomości) zawsze gra przez domyślne wyjście systemu.

## Widok na telefonie (od 0.16.0)

- Szybkie przyciski mieszczą się w jednym przewijanym rzędzie.
- Osoby z prawem mówienia widzą duży przycisk „Przytrzymaj i mów”. Pole tekstowe otwiera się przyciskiem ⌨️, a 🎙 wraca do mówienia. Dzięki temu na wiadomości zostaje dużo więcej miejsca.
- Kto mówi, widać na zielonym pasku pod nagłówkiem.
- Na pasku planu jest napis „TERAZ”, a zielona kropka oznacza Planning Center Live. Napis „LIVE” jest zarezerwowany dla transmisji.
- W poziomie ekran jest ciaśniejszy, a pole tekstowe i przycisk mówienia są w jednym rzędzie.
- Informacje o wejściach i wyjściach łączą się w jedną linię. Szybkie ponowne połączenie (np. po wygaszeniu ekranu) nie jest pokazywane.
- Panel administracyjny jest dostosowany do telefonu: osoby online są pokazane jako karty, a kanały i szybkie przyciski w czytelnym układzie.

## Odliczanie czasu punktów (od 0.17.0)

Przy bieżącym punkcie planu (na pasku planu, w planie i w widoku podzielonym) widać, ile czasu zostało do jego końca.

- **Zgodne z Planning Center Live.** Liczone jest od chwili, w której punkt rozpoczęto w PC Live, według jego długości w planie. Gdy PC Live nie jest używany, liczone jest od momentu ręcznej zmiany punktu w Interkomie.
- Wszystkie telefony używają zegara serwera, więc odliczanie jest identyczne nawet przy źle ustawionym zegarze w telefonie.
- **Kolory:** ostatnia minuta na pomarańczowo, przekroczenie na czerwono (np. „+1:30”). Przy punktach bez ustalonej długości widać czas od rozpoczęcia (⏱).
- W planie widać też przewidywaną godzinę końca nabożeństwa: reszta bieżącego punktu plus długości kolejnych.

## Powiadomienia i wibracje na zablokowanym telefonie (od 0.18.0)

W ustawieniach aplikacji, w sekcji **Powiadomienia na zablokowanym ekranie**, każdy wybiera, o czym chce być powiadamiany. Wezwania i PILNE! przychodzą zawsze. Do wyboru:

- 💬 wiadomości prywatne (domyślnie włączone);
- 📢 wiadomości i wypowiedzi na kanałach, których słuchasz, razem z transkrypcją (domyślnie włączone);
- ▶ zmiana punktu planu;
- ⏳ koniec czasu punktu: ostatnia minuta i przekroczenie. Przy otwartej aplikacji też wibracja i komunikat;
- 🔴 transmisja live: start, koniec, problemy.

Zasady działania:

- Powiadomienie przychodzi tylko wtedy, gdy aplikacja jest w tle albo telefon jest zablokowany. Przy otwartej aplikacji działają zwykłe dźwięki, wibracje i lektor.
- Kilka wiadomości w krótkim czasie łączy się w jedno powiadomienie („+2 wcześniej”), żeby telefon nie wibrował bez przerwy.
- Każdy rodzaj ma własny wzór wibracji, wezwanie najdłuższy. Na iPhonie wibracje powiadomień ustawia się w systemie (Dźwięki i haptyka). Przy otwartej aplikacji iPhone nie pozwala stronom wibrować.
- Na iPhonie powiadomienia działają tylko z aplikacją dodaną do ekranu początkowego.

## Plan: przypięty bieżący punkt, zwarty program, klawiatura (od 0.19.0)

- U góry widoku planu (w panelu bocznym i na telefonie) zawsze widać bieżący i następny punkt, odliczanie oraz przyciski ◀ ▶. Przewija się tylko lista programu pod spodem.
- Lista przewija się do bieżącego punktu tylko wtedy, gdy punkt się zmieni, i nie wtedy, gdy ktoś właśnie ją przewija. Odświeżenie planu nie przesuwa listy.
- Cały program jest zwarty: jedna linia na punkt, kropka oznacza notatki. Dotknięcie rozwija szczegóły. Zmiana punktu działa tylko osobnym przyciskiem „▶ Przełącz Live na ten punkt”, więc przypadkowe dotknięcie niczego nie przełączy.
- Klawiatura: → lub PageDown to następny punkt, ← lub PageUp to poprzedni. Działa też pilot do prezentacji. Przytrzymanie klawisza przesuwa tylko o jeden punkt, a pisanie w polu tekstowym nie zmienia planu.

## iPhone: powiadomienia i aplikacja z ekranu początkowego (od 0.20.0)

- **Powiadomienia na iPhonie.** Serwer podpisywał powiadomienia adresem `mailto:interkom@localhost`, który Apple odrzuca (403 BadJwtToken). Android i komputery to przyjmowały, dlatego problem dotyczył tylko iPhone'ów. Teraz serwer podpisuje się swoim prawdziwym adresem (`https://adres-interkomu`), który poznaje z pierwszego połączenia telefonu i zapamiętuje. Można go też ustawić ręcznie w `.env`: `VAPID_SUBJECT=https://twoja-domena` albo `mailto:adres@parafii.pl`.
- **„Wyślij test”** pokazuje teraz wynik, czyli czy Apple/Google przyjął powiadomienie, a jeśli nie, to z jakim powodem.
- **Aplikacja z ekranu początkowego.** iOS zostawiał stronę przesuniętą po schowaniu klawiatury, więc dotyk trafiał obok przycisków. Do tego panele używały elementów „sticky”, które iOS źle mapuje na dotyk. Teraz dokument nie może się przesunąć, a panele mają stały nagłówek i przewijaną treść.

## Oznaczanie @ i ksywki (od 0.21.0)

- **Oznaczanie w wiadomościach.** Wpisz `@` w polu wiadomości, a pojawi się lista zalogowanych osób, wyszukiwana po imieniu i ksywkach. Stuknięcie (albo Enter / Tab) wstawia oznaczenie. `@wszyscy` oznacza wszystkich słuchających danego kanału. Oznaczenie wpisane ręcznie, np. `@akustyk`, też działa, o ile pasuje do jednej osoby.
- **Oznaczona osoba:**
  - widzi wiadomość podświetloną na żółto;
  - dostaje sygnał, wibrację i komunikat, także gdy nie słucha tego kanału, a lektor czyta „Kasia do Ciebie: …”;
  - na zablokowanym telefonie dostaje push. Można to wyłączyć w ustawieniach: „@ oznaczeniu mnie”.
- **Ksywki:**
  - każdy ustawia swoje w ustawieniach aplikacji („Twoje ksywki”, maks. 4);
  - administrator ustawia je dla wszystkich w panelu (Stan → Ksywki), łącznie z osobami z grafiku Planning Center, które nie są zalogowane;
  - osobom z Planning Center ksywki zostają na stałe, zalogowanym PIN-em do wylogowania;
  - ksywki widać na liście osób online.

## ProPresenter: zegar zsynchronizowany z Planning Center (od 0.22.0)

Interkom ustawia wybrany zegar (timer) w ProPresenter 7 na czas pozostały do końca bieżącego punktu według Planning Center Live i pilnuje, żeby się nie rozjechał. Zegar wstawiasz na ekran sceny (Stage Display) albo do slajdu jak każdy inny zegar ProPresentera.

**Włączenie:**
1. W ProPresenterze (wersja 7.9 lub nowsza): **Ustawienia → Sieć → Włącz sieć**. Zanotuj adres IP i port, które tam widać.
2. W panelu Interkomu: zakładka **Planning Center → ProPresenter – zegar punktu**. Zaznacz „Synchronizuj”, wpisz IP i port, a potem zapisz.
3. Wybierz, gdzie stoi serwer Interkomu:
   - **w sieci kościoła** (mini PC): serwer łączy się z ProPresenterem bezpośrednio;
   - **w chmurze (VPS)**: serwer nie widzi komputerów w kościele, więc zegar ustawia mostek z zakładki **Transmisja** (ten sam program co dla Web Presenterów). Mostek musi działać na komputerze w sieci kościoła. Wystarczy go uruchomić, ustawienia pobierze sam.
4. W ProPresenterze pojawi się zegar „Interkom – punkt”. Wstaw go na ekran sceny. Opcjonalnie drugi zegar odlicza czas do końca nabożeństwa.

**Jak działa:**
- przy zmianie punktu w Planning Center (z aplikacji, z PCO albo strzałkami) zegar ustawia się na długość punktu minus czas, który już minął;
- gdy zegar różni się od Planning Center o więcej niż ~2,5 s, albo ktoś go zatrzyma ręcznie, Interkom go poprawia;
- po przekroczeniu czasu zegar liczy na minusie;
- gdy plan się skończy lub punkt nie ma długości, zegar zostaje zatrzymany;
- stan połączenia, czas w ProPresenterze i oczekiwany czas widać w panelu. Przycisk „Synchronizuj teraz” wymusza ponowne ustawienie.

**Ograniczenia:**
- ProPresenter nie pozwala ustawić zegara na wartość ujemną. Jeśli przełączysz się na punkt, który według Planning Center już się przeciągnął, zegar zacznie liczyć od 0:00 w dół.
- Starsze wersje ProPresentera (6 i 7 przed 7.9) nie mają tego API.

## Instrukcja obsługi w aplikacji (od 0.23.0)

- Strona **/pomoc** zawiera pełną instrukcję ze zrzutami ekranu. Jest dopasowana do telefonu i komputera, a na szerokim ekranie ma spis treści z boku.
- Link do niej jest w ⚙️ (**📖 Instrukcja obsługi**), na ekranie logowania i w panelu administratora (**📖 Pomoc**).
- Instrukcję w PDF można pobrać przyciskiem **⬇ PDF** (plik `app/public/pomoc/Interkom-instrukcja.pdf`). PDF powstaje z tej samej strony przez wydruk w Chromium, więc treść jest zawsze ta sama.

## Ustawienia i klucze wpisujesz tylko raz (od 0.24.0)

Dotąd ustawienia (`.env`, `config/`, `data/`) leżały w folderze programu. Gdy przy aktualizacji ktoś usunął ten folder albo rozpakował nową wersję w innym miejscu, trzeba było od nowa podawać klucze Planning Center, domenę itd.

- **Ustawienia leżą teraz poza folderem programu, w `/var/lib/interkom`:** konfiguracja, klucze (Planning Center, YouTube, Facebook, mostek), ksywki, powiadomienia, certyfikaty i modele rozpoznawania mowy. W folderze programu są tylko dowiązania do nich. Instalator przy pierwszym uruchomieniu nowej wersji sam przenosi istniejące ustawienia, więc nic nie trzeba robić ręcznie. Inne miejsce można wskazać zmienną `IK_HOME`, np. `sudo IK_HOME=/srv/interkom ./install.sh`.
- **Instalator nie pyta o Planning Center**, jeśli klucze są już zapisane (w `.env` albo w panelu).
- **Kopia ustawień w panelu** (zakładka Stan):
  - „⬇ Pobierz kopię” zapisuje jeden plik JSON z całą konfiguracją: PIN-y, kanały, przyciski, uprawnienia, klucze Planning Center (także te z `.env`), YouTube, Facebook, token mostka, ksywki, klucze i subskrypcje powiadomień;
  - „⬆ Wczytaj kopię” odtwarza to wszystko na innym serwerze, np. przy przenosinach z VPS na mini PC. Wystarczy świeża instalacja i wczytanie pliku. Interkom uruchamia się wtedy ponownie po kilku sekundach;
  - plik zawiera hasła i klucze, więc trzymaj go jak hasło.
- Po przeniesieniu na inny adres użytkownicy logują się ponownie, a powiadomienia na telefonach trzeba włączyć jeszcze raz (zgoda na powiadomienia jest przypisana do adresu strony).

## Powiadomienia tylko dla osób „w akcji” (od 0.25.0)

**Błąd:** serwer pamiętał telefon każdej osoby, która kiedykolwiek włączyła powiadomienia, i wysyłał je bez końca. Wystarczyło być na jednym nabożeństwie, żeby dostawać powiadomienia z kolejnych, nawet bez logowania. Osobom logującym się PIN-em każde logowanie dokładało nowy zapis, a stare nadal działały.

**Teraz telefon dostaje powiadomienia tylko wtedy, gdy spełnione są wszystkie warunki:**
- sesja jest ważna, czyli osoba się nie wylogowała, a logowanie nie wygasło (24 h);
- osoba miała interkom otwarty w ciągu ostatnich **6 godzin**. Zablokowanie telefonu w trakcie nabożeństwa niczego nie psuje. Przy kolejnym nabożeństwie wystarczy otworzyć interkom. Okno można zmienić w `.env`: `IK_PUSH_ACTIVE_H=8`.

**Dodatkowo:**
- **Wyloguj** od razu wyłącza powiadomienia na tym telefonie;
- gdy na tym samym telefonie zaloguje się ktoś inny, powiadomienia dostaje tylko nowa osoba;
- zapisy z poprzednich wersji są nieaktywne, dopóki dana osoba nie otworzy interkomu;
- zapisy nieużywane od tygodnia są usuwane.

## Dźwięk transmisji dla ekipy (od 0.26.0)

Miks z konsolety, ten sam, który idzie na transmisję, może słyszeć każdy w aplikacji. Każdy sam włącza odsłuch i ustawia głośność.

**Nadajnik:**
1. W panelu otwórz zakładkę **🎵 Dźwięk transmisji**. Włącz, zapisz i kliknij **Wygeneruj link nadajnika**.
2. Otwórz link w Chrome lub Edge na komputerze w kościele, który ma wejście z miksem, np. interfejs audio USB podłączony do wyjścia Mix/Matrix. Link (z kluczem) zapamiętuje się na tym komputerze.
3. Wybierz wejście, sprawdź wskaźnik L/P i kliknij **▶ Nadawaj**. Opcja „Nadawaj automatycznie” przydaje się na stałym komputerze.

Jak to działa:
- dźwięk idzie w stereo, w jakości wybranej w panelu (96–320 kb/s Opus, domyślnie 160 kb/s), bez redukcji echa i szumów, przez ten sam serwer głosu (LiveKit) co rozmowy;
- **🔇 Wycisz** na nadajniku chwilowo wycisza dźwięk u wszystkich;
- po utracie internetu nadajnik sam się łączy ponownie;
- nowy link w panelu od razu rozłącza stary nadajnik;
- wielokanałowe USB z konsolety (np. Allen & Heath Qu przez USB-B) przeglądarka zwykle widzi jako kanały 1–2. Ustaw na nich miks do transmisji albo użyj interfejsu stereo.

**W aplikacji:**
- przycisk **🎵** u góry ekranu pojawia się, gdy nadajnik działa;
- w okienku włączasz **Słucham** i ustawiasz suwak głośności. Działa to niezależnie od głośności rozmów i także na iPhonie (dźwięk idzie przez Web Audio);
- gdy ktoś mówi przez interkom, transmisja jest automatycznie ściszana do poziomu ustawionego w panelu (domyślnie 30%). Każdy może to wyłączyć u siebie;
- gdy odsłuch jest wyłączony, serwer w ogóle nie wysyła tego dźwięku na telefon.

Opóźnienie wynosi ok. 0,2–0,5 s. To wystarcza do kontroli dźwięku transmisji, ale nie jako odsłuch dla muzyków.

## Nadajnik: poziom wejścia i wybór kanałów (od 0.27.0)

**Poziom wejścia:**
- suwak −24…+24 dB (co 0,5 dB, przyciski ± i „0”) z **ogranicznikiem**, który chroni przed przesterowaniem po podbiciu;
- wskaźnik L/P pokazuje poziom po regulacji, czyli to, co słyszą słuchacze;
- ustawienia zapamiętują się dla każdego wejścia osobno.

**Kanały:**
- tryb **Stereo** (wybór kanału dla L i P) albo **Mono** (suma dwóch kanałów na oba uszy);
- Chrome i Edge udostępniają stronom tylko **kanały 1–2** wejścia. To ograniczenie przeglądarki;
- **Allen & Heath Qu-SB (USB-B):** w Setup → I/O Patch → USB Audio przypisz miks do transmisji do **USB Send 1–2** (domyślnie Main LR jest na 17–18);
- **Dante Virtual Soundcard:** w Dante Controller podłącz miks do **DVS Receive 1–2**. Na Windows w trybie WDM DVS widać jako kilka wejść stereo (pary kanałów), wtedy właściwą parę wybierasz z listy wejść;
- Firefox widzi więcej kanałów. Wtedy w polach L/P można wybrać np. 17–18.

**Zdalnie z panelu** (Dźwięk transmisji) można zmieniać poziom wejścia nadajnika i wyciszać dźwięk u wszystkich. Zmiana dochodzi w ciągu ok. 2 s.

**Automatyczny start bez kliknięcia:** przeglądarka nie uruchamia obróbki dźwięku, dopóki ktoś nie kliknie w stronę. Do tego czasu nadajnik nadaje kanały 1–2 bez regulacji i pokazuje ostrzeżenie (widać je też w panelu). Po pierwszym kliknięciu przełącza się na tor z regulacją bez przerwy w nadawaniu.

**„Kto mówi”** pokazuje się teraz w nagłówku, w miejscu nazwy, a nie jako pasek zasłaniający zakładki kanałów.

## Mniejsze i mierzone opóźnienie dźwięku transmisji (od 0.28.0)

- **Tor bezpośredni na nadajniku.** Przy ustawieniach neutralnych (0 dB, stereo z kanałów 1/2) dźwięk idzie prosto z wejścia, z pominięciem Web Audio, co daje ok. 20 ms mniej. Gdy zmienisz poziom albo kanały, obróbka włącza się sama, bez przerwy w nadawaniu. Ogranicznik działa tylko w torze z obróbką.
- **Pomiar w okienku 🎵** pokazuje szacowane opóźnienie, np. „ok. 100 ms”, z podziałem na:
  - nadajnik (wejście, obróbka, ramka Opus 20 ms, droga do serwera);
  - sieć do telefonu;
  - bufor wyrównujący Wi-Fi;
  - odtwarzanie.
- **Ostrzeżenia w okienku 🎵:**
  - słuchawki Bluetooth (+150–250 ms);
  - połączenie przez TCP, gdy port 7882/udp jest zablokowany;
  - duży bufor przy nierównym Wi-Fi;
  - gubione pakiety.
- **Panel** (Dźwięk transmisji) pokazuje opóźnienie po stronie nadajnika i to, czy działa tor bezpośredni.
- Największą różnicę zrobi przeniesienie serwera z VPS na mini PC w kościele: znika wtedy droga przez internet w obie strony. Pomiar pokaże to od razu w pozycji „sieć”.

## Lokalny odsłuch: dźwięk transmisji prosto z komputera w kościele (od 0.29.0)

Gdy serwer stoi na VPS, dźwięk transmisji nie musi lecieć do serwerowni i z powrotem. Strona nadajnika działa jako mały **lokalny serwer dźwięku**: sama wysyła dźwięk (WebRTC) każdemu telefonowi w tej samej sieci. Nic nie trzeba instalować.

**Jak to działa:**
- serwer w chmurze tylko pośredniczy przy zestawianiu połączenia (kilka wiadomości). Sam dźwięk idzie bezpośrednio w sieci kościoła;
- telefon w sieci kościoła po włączeniu 🎵 łączy się z nadajnikiem w ok. 1 s. W okienku widać wtedy „na żywo · lokalnie”;
- kto jest poza siecią (LTE, inne Wi-Fi), słucha przez serwer jak dotąd. Aplikacja próbuje połączenia lokalnego przez kilka sekund i bez przerwy w dźwięku zostaje przy serwerze;
- gdy połączenie lokalne zerwie się w trakcie, dźwięk wraca do serwera, a aplikacja po chwili próbuje znów lokalnie.

**Parametry w sieci lokalnej:**
- Opus stereo w ramkach 10 ms zamiast 20 ms, czyli 100 pakietów/s;
- tylko adresy lokalne, bez serwerów pośredniczących;
- w testach całe opóźnienie wyniosło ok. 60 ms, wobec ok. 110 ms przez serwer w tej samej sieci. Przez VPS dochodzi jeszcze droga przez internet w obie strony.

**Obsługa:**
- poziom wejścia, kanały i wyciszenie na nadajniku działają tak samo dla słuchaczy lokalnych i tych przez serwer;
- strona nadajnika pokazuje, kto słucha lokalnie. Panel pokazuje liczbę słuchających lokalnie;
- funkcję wyłączysz w panelu: Dźwięk transmisji → „Lokalny odsłuch”;
- jeden nadajnik obsłuży lokalnie do 40 telefonów, przy 160 kb/s to ok. 6,5 Mb/s razem w sieci lokalnej (przy 320 kb/s – ok. 13 Mb/s).

**Wymagania sieci:** telefony i komputer z nadajnikiem muszą się „widzieć” w sieci. Wyłączona izolacja klientów Wi-Fi albo ta sama podsieć dla kabla i Wi-Fi. W sieci dla gości z izolacją klientów lokalny odsłuch się nie połączy i zostanie odsłuch przez serwer.

## ⚡ Tryb ultra: własny bufor zamiast mechanizmu WebRTC (od 0.30.0)

W WebRTC bufor odtwarzania ustala sama przeglądarka (NetEQ) i nie da się go zmniejszyć. Strona może go tylko zwiększać. Dlatego dla odsłuchu w sieci kościoła powstał osobny tor, w którym bufor kontroluje Interkom:

- **nadajnik** koduje dźwięk raz dla wszystkich słuchaczy (WebCodecs, Opus w trybie *low-delay*, ramki 10 ms, ok. 2,5 ms opóźnienia algorytmu). Pakiety idą do telefonów kanałem danych WebRTC **bez powtórzeń i bez kolejności**, czyli jak UDP. Spóźniony pakiet jest pomijany, a nie wstrzymuje reszty;
- **telefon** dekoduje Opus (WASM, działa także na starszych iPhone'ach) i odtwarza w AudioWorklet z **własnym buforem**:
  - rozmiar dobiera sam z rzeczywistego rozrzutu pakietów z ostatnich 4 s (97. percentyl + margines);
  - po przycięciu dźwięku chwilowo powiększa bufor, a po spokojnym okresie zmniejsza go z powrotem;
  - lekko przyspiesza albo zwalnia (±2–3%), żeby trzymać zadany bufor i wyrównać zegary nadajnika i telefonu (także 44,1/48 kHz);
  - nadmiar po chwilowym zatorze przeskakuje, zamiast grać z opóźnieniem;
- **wybór bufora** w okienku 🎵:
  - *Automatyczny* (zalecany, od 10 ms);
  - *Minimalny* (od 5 ms, możliwe trzaski);
  - *Stabilny* (od 40 ms, na słabe Wi-Fi);
- przy włączonym trybie ultra okienko pokazuje „⚡ ultra”, a nadajnik oznacza takich słuchaczy ⚡;
- potrzebny jest dźwięk odblokowany dotknięciem: przy pierwszym dotknięciu 🎵 telefon sam przechodzi z trybu lokalnego na ultra;
- jeśli przeglądarka nie obsłuży trybu ultra (albo nadajnik nie ma WebCodecs), zostaje zwykły tor lokalny, a w ostateczności serwer;
- tryb można wyłączyć u siebie (⚡ Tryb ultra w okienku 🎵).

**Pomiar na jednym komputerze** (bez Wi-Fi), tryb Automatyczny, 20 s: bufor 11–23 ms, 0 przycięć, całość ok. 64 ms. Tryb Minimalny: 9–35 ms, z kilkoma przycięciami. Stabilny: ok. 40 ms bez przycięć. Na prawdziwym Wi-Fi zysk wobec zwykłego WebRTC powinien być większy, bo NetEQ dobiera bufor ostrożnie i długo go nie zmniejsza. Trzeba to sprawdzić pomiarem na miejscu.

Nowa zależność: `opus-decoder` (MIT), serwowana pod `/vendor-opus/`.

## Nadajnik dźwięku na serwerze, sterowany tylko z panelu (od 0.31.0)

Nowa usługa **audio** (osobny kontener). Serwer sam czyta wejście audio, przetwarza dźwięk i wysyła go do telefonów. Przeglądarka ani drugi komputer nie biorą w tym udziału, a panel tylko zmienia ustawienia.

**Tor dźwięku:** wejście ALSA (line-in płyty głównej, interfejs USB, Qu-SB przez USB-B) → wybór kanałów (stereo L/P albo mono z sumy) → poziom −24…+24 dB → ogranicznik → Opus w trybie *low-delay*, ramki 10 ms. Stąd dźwięk idzie dwiema drogami:
- telefony w sieci lokalnej dostają go **w trybie ultra** (kanał danych WebRTC bez powtórzeń, własny bufor w telefonie);
- pozostali, poza siecią, albo bez dotknięcia ekranu, dostają go **przez LiveKit**. Ta droga jest obecnie **mono**: biblioteka LiveKit dla serwera nie przekazuje jeszcze stereo.

**Sterowanie** w panelu (Dźwięk transmisji → „Skąd brać dźwięk?” → **Wejście audio tego serwera**, zapisz):
- włącz/wyłącz nadawanie;
- wybór wejścia (lista wykrytych kart; „↻” szuka ponownie) oraz kanałów. Widać wszystkie kanały urządzenia, np. 18 z Qu-SB, bez ograniczenia przeglądarek do 1–2;
- poziom, ogranicznik, „Wycisz u wszystkich”;
- wskaźnik L/P na żywo, stan nadajnika, liczba słuchających lokalnie i opóźnienie;
- zmiany działają od razu i są zapamiętywane w konfiguracji, więc po restarcie serwer sam wraca do nadawania;
- **„Sygnał testowy”** (440 Hz lewy / 660 Hz prawy) pozwala sprawdzić cały tor bez konsolety.

**Instalacja:** instalator sam włącza usługę (`COMPOSE_PROFILES=audio` w `.env`), gdy serwer ma kartę dźwiękową (`/dev/snd`). Na VPS-ie bez karty usługa się nie uruchamia.

**Strona nadajnika w przeglądarce** działa dalej. Gdy wybrane jest źródło „serwer”, strona odmawia nadawania (żeby dwa nadajniki się nie biły), i odwrotnie.

**Line-in w Dell OptiPlex Micro** (np. 3090) to przełączane gniazdo z przodu (wyjście/wejście):
1. Przestaw je na wejście, np. narzędziem `hdajackretask` z pakietu `alsa-tools` (wymaga środowiska graficznego, można je uruchomić raz) albo przez plik `hda-jack-retask.fw`. W `alsamixer` (F4 = nagrywanie) ustaw źródło nagrywania na „Line” i poziom wejścia.
2. Sygnał z konsolety ścisz (wejście komputera przyjmuje −10 dBV, niesymetrycznie) i najlepiej podłącz przez DI albo transformator z odcięciem masy. Bez tego łatwo o brum 50 Hz.
3. Gdy to sprawia kłopot, prostszy jest mały interfejs audio USB (zgodny z USB Audio, działa bez sterowników).

**Dante:** Dante Virtual Soundcard nie działa na Linuksie. Do serwera trzeba wejść przez adapter Dante → USB albo z wyjścia analogowego.

**Opóźnienie po stronie serwera:** wejście ALSA (bufor 5–20 ms) + ramka 10 ms + Opus 2,5 ms. Test z sygnałem testowym na jednym komputerze, tryb ultra „Automatyczny”: całość ok. 50–55 ms (bufor w telefonie ok. 10–20 ms).

## Aplikacja na iPhone i Android (od 0.32.0)

W folderze `mobile/` jest projekt aplikacji (Capacitor 8 + natywny dźwięk LiveKit). Aplikacja wczytuje zwykłą stronę interkomu z serwera, ale dźwięk obsługuje natywnie:
- słuchanie i mówienie **przy zablokowanym ekranie**;
- **przyciski sprzętowe**: przycisk na słuchawkach / Bluetooth (play/pauza), piloty PTT Bluetooth, przyciski głośności. Na Androidzie można też „nauczyć” aplikację dowolnego przycisku PTT;
- powiadomienia (wezwania, wiadomości) przychodzą przez połączenie aplikacji, bez Web Push.

**Serwer:** nowe endpointy `/api/native/beat`, `/api/native/ptt`, `/api/native/bye`. Serwer sam wysyła telefonowi (kanałem danych LiveKit, temat `ik`) listę osób, które ma słyszeć, oraz powiadomienia. Dzięki temu nic nie zależy od strony uśpionej w tle. Telefon z aplikacją w tle widać na liście obecnych.

**Dystrybucja bez sklepów:** iPhone przez TestFlight (konto Apple Developer), Android jako plik APK. Instrukcja budowania: `mobile/README.md`.

Ograniczenia: na iPhonie przycisk słuchawek działa jako przełącznik (naciśnij – mów, naciśnij – koniec). Dźwięk transmisji w aplikacji idzie przez LiveKit, bez trybu ultra i bez trybu lokalnego.

## Wybór serwera w aplikacji i wyszukiwanie w sieci (od 0.33.0)

Aplikacja na telefon (mobile 1.1.0) nie ma już adresu serwera wpisanego na stałe. Startuje od ekranu wyboru:
- serwery znalezione w sieci Wi-Fi;
- ostatnio używane;
- adres wpisany ręcznie.

Wybrany serwer jest zapamiętywany. Zmienia się go przyciskiem **🔁 Zmień serwer** (ekran logowania, ⚙️).

**Serwer:** instalator (tryby z domeną w Cloudflare i z adresem IP) instaluje `avahi-daemon` i ogłasza usługę `_interkom._tcp` z adresem (`url=https://…`), nazwą parafii i wersją (`/etc/avahi/services/interkom.service`). W `ufw` otwiera port 5353/udp. Na VPS-ie nic się nie zmienia, bo serwera w internecie nie da się wyszukać w sieci lokalnej.

## Wygląd: kolor przewodni i logo (od 0.34.0)

Panel → **Ogólne → Wygląd**:
- **Kolor przewodni**, wybierany z gotowych kolorów albo dowolny. Zmienia przyciski, zaznaczenia, własne wiadomości i @wzmianki. Gdy kolor jest jasny, napisy na przyciskach same zmieniają się na ciemne.
- **Logo** (PNG, JPG, WebP lub SVG, do 2 MB). Pojawia się na ekranie logowania i w nagłówku obok nazwy. Najlepiej wygląda poziome logo z przezroczystym tłem.

- **Kolor logo** (od 0.34.1, dla SVG i PNG z przezroczystym tłem) ma do wyboru: oryginalne kolory, białe, czarne, jak kolor przewodni albo własny kolor. Całe logo dostaje wtedy jeden kolor, więc najlepiej działa logo jednobarwne.

Zmiany widać od razu u wszystkich, także w aplikacji na telefon, bez jej przebudowy. Logo leży w `data/branding/` i wchodzi do kopii zapasowej. Ikona aplikacji na ekranie telefonu się nie zmienia, bo jest wbudowana w aplikację.

## Mikser osobisty (od 0.35.0)

Przycisk **🎚** w nagłówku otwiera mikser z czterema pionowymi suwakami, każdy z przyciskiem MUTE:
- **Głosy:** rozmowy przez interkom. MUTE działa jak „Odtwarzaj głos: wyłączone”;
- **Transmisja:** dźwięk z konsolety, ten sam poziom co w okienku 🎵. MUTE wyłącza słuchanie;
- **Komunikaty:** lektor czytający zmianę punktu planu, wiadomości i komunikaty o transmisji live;
- **Sygnały:** dźwięki wezwań i wiadomości pilnych.

Pod suwakami jest też przełącznik „Ściszaj transmisję, gdy ktoś mówi”. Ustawienia zapisują się na danym urządzeniu. Działają w przeglądarce i w aplikacji na telefon; tam głosy i transmisja są regulowane natywnie, także przy zablokowanym ekranie.

Podpowiedzi w polach (placeholdery) są neutralne, bez nazw parafii i osób. Domyślna nazwa nowej instalacji to „Interkom”.

## Stan serwera i ponowne uruchomienie z panelu (od 0.36.0)

Panel → **Serwer**:
- **procesor** (obciążenie, liczba rdzeni, średnie obciążenie), **pamięć**, **dysk**, **temperatura** (o ile komputer ma czujnik) i czas pracy komputera oraz interkomu;
- **usługi**: Interkom, Głos (LiveKit), Transkrypcja i Nadajnik dźwięku (gdy źródłem jest wejście serwera);
- przyciski **Uruchom ponownie interkom** (wszystkie usługi, ok. 30 s), **Uruchom ponownie komputer** i **Wyłącz komputer**, każdy z potwierdzeniem.

Restart i wyłączenie komputera obsługuje usługa systemd `interkom-control` (instaluje ją `install.sh`). Aplikacja w kontenerze zapisuje polecenie do pliku `data/app/control/request`, a usługa na serwerze je wykonuje. Kontener nie dostaje przez to żadnych dodatkowych uprawnień. Bez tej usługi, np. przed ponownym uruchomieniem instalatora, działa tylko restart samej aplikacji.

## Dostęp spoza sieci kościoła dla operatorów zdalnych (od 0.37.0)

Dotyczy trybu DuckDNS (4). Działa przez przekierowanie portów na routerze kościoła:
1. Na duckdns.org dodaj **drugą** subdomenę, np. `nazwa-zdalnie`.
2. Na serwerze: `sudo ./install.sh --remote` i podaj tę subdomenę. Instalator wpisuje w niej **publiczny** adres kościoła i aktualizuje go co 5 minut (usługa `interkom-ddns.timer`). Przy okazji serwer WWW dostaje certyfikat dla obu nazw, a LiveKit ogłasza telefonom adres publiczny i lokalny.
3. W routerze przekieruj na serwer porty **443/TCP, 7881/TCP i 7882/UDP**.
4. W Planning Center dopisz adres powrotu `https://nazwa-zdalnie.duckdns.org/auth/pco/callback`.

W kościele nadal używa się nazwy lokalnej. Dźwięk płynie wtedy bezpośrednio w sieci lokalnej, bez wychodzenia do internetu. Operatorzy zdalni otwierają nazwę zdalną w przeglądarce albo wpisują ją w aplikacji (🔁 Zmień serwer).

**Bezpieczeństwo** (panel → Dostęp i PIN-y → Dostęp spoza sieci kościoła):
- spoza sieci domyślnie można logować się **tylko kontem Planning Center**. PIN ekipy i PIN mówiącego działają tylko w sieci kościoła, chyba że administrator na to pozwoli;
- **panel administracyjny** spoza sieci jest domyślnie zablokowany;
- jednym przełącznikiem można wyłączyć cały dostęp z internetu;
- ograniczenie prób PIN liczy się według prawdziwego adresu klienta. Aplikacja ufa nagłówkom przekazywania adresu tylko od własnego serwera WWW.

Wyłączenie: `sudo ./install.sh --remote-off`, a potem usuń przekierowania w routerze.

## 0.37.1

- Nowa instrukcja PDF i nowa strona Pomoc: mikser, aplikacja na telefon, praca zdalna, stan serwera, wygląd oraz rozdział o instalacji i utrzymaniu serwera. Zrzuty ekranu nie zawierają nazw parafii ani osób.
- Poprawka: logo SVG bez podanych wymiarów nie było widać w oryginalnych kolorach.
- Panel: temperatura procesora jest odczytywana z czujnika procesora. Wcześniej panel mógł pokazać błędne 126°C z nieużywanego czujnika płyty.
- Aplikacja mobilna 1.1.1: ekran wyboru serwera nie wychodzi poza ekran przy długich adresach (wymaga przebudowy aplikacji).

## Przyciski pobrania aplikacji na ekranie logowania (od 0.38.0)

Panel → **Ogólne → Aplikacja na telefon**: wklej link do App Store albo publiczny link TestFlight (iPhone) oraz link do Google Play albo do pliku APK (Android). Na ekranie logowania i w ustawieniach w przeglądarce pojawią się wtedy przyciski do pobrania. Napis na przycisku dopasowuje się do linku („App Store”, „TestFlight”, „Google Play”, „Androida (APK)”), a na telefonie najpierw pokazuje się przycisk dla jego systemu. W samej aplikacji przyciski są ukryte. Puste pole oznacza brak przycisku.

## 0.38.1

- Poprawka: na serwerze w internecie (tryb VPS) zasady „spoza sieci kościoła” blokowały panel administracyjny i logowanie PIN-em, bo w tym trybie każdy łączy się z zewnątrz. Teraz te zasady działają tylko na serwerze w sieci kościoła (tryby 1, 2 i 4).

## 0.39.0 (aplikacja 1.2.0)

- W aplikacji na telefon **lektor** (komunikaty planu, wiadomości, transmisja) i **sygnały** (wezwania, PILNE!) są odtwarzane natywnie: na iPhonie przez AVSpeechSynthesizer, na Androidzie przez TextToSpeech i ToneGenerator. Działają też w tle i przy zablokowanym ekranie. Poziom ustawia się suwakami „Komunikaty” i „Sygnały” w mikserze. Synteza mowy w WebView bywała niema, gdy działał dźwięk rozmów.
- iPhone: przy łączeniu aplikacja zawsze odcisza mikrofon w systemie. Wersja testowa z obsługą AirPods mogła zostawić go wyciszonego.
- Wymaga przebudowy aplikacji (`npm run sync` i Xcode / Android Studio). Strona działa też ze starszą aplikacją, wtedy lektor korzysta z syntezy mowy przeglądarki.

## 0.39.1

- Poprawka instalatora: po zmianie konfiguracji głosu albo HTTPS (np. `--remote`, zmiana domeny lub adresu IP) instalator sam uruchamia ponownie LiveKit i Caddy. Wcześniej te usługi działały dalej ze starymi ustawieniami, bo ich obraz się nie zmieniał. Przez to telefony spoza sieci łączyły się z tekstem, ale bez głosu.

## 0.44.6
- Instalator 0.44.4–0.44.5 przerywał się w linii 408 (sklejone dwa polecenia przy instalacji usługi aktualizacji z panelu). Poprawione; sekcja usługi sterowania jest teraz sprawdzana w teście w całości.

## 0.44.5
- **Dźwięk transmisji w przeglądarce zmieniał wysokość** (przy przełączaniu kart, otwieraniu ustawień, włączaniu opcji – także bez trybu ⚡ ultra i poza siecią kościoła). Transmisja szła przez Web Audio (AudioContext), a Chrome nie nadąża w nim za zmianą częstotliwości wyjścia – np. gdy słuchawki Bluetooth (AirPods) przechodzą w tryb rozmowy, bo strona na chwilę otwiera mikrofon (ustawienia: podgląd poziomu, powrót na kartę), albo gdy inna karta czy program przestawi urządzenie. Dźwięk grał wtedy za szybko lub za wolno. Teraz na komputerze i Androidzie transmisja gra zwykłym elementem audio (przeglądarka sama dopasowuje się do urządzenia, głośność i ściszanie działają jak dotąd). Web Audio zostaje tylko na iPhonie/iPadzie, gdzie bez niego nie da się zmieniać głośności.

## 0.44.4
- **Aktualizacja z panelu** (zakładka Serwer → Aktualizacje): „Sprawdź aktualizacje” pokazuje, czy na GitHubie jest nowsza wersja i co się w niej zmieniło (sprawdza też sam przy wejściu w zakładkę, najwyżej co 30 min), „Aktualizuj teraz” pobiera ją i uruchamia instalator. Panel pokazuje postęp, po zakończeniu sam się odświeża, a dziennik ostatniej aktualizacji jest pod przyciskami. Wykonuje to usługa sterowania na serwerze (ta sama co restart): git działa jako właściciel folderu interkomu (jego klucz do GitHuba), instalator jako osobna usługa systemd, więc restart kontenerów go nie przerywa. **Jednorazowo** po tej wersji trzeba zaktualizować z SSH (`./update.sh`) – wtedy instaluje się nowa usługa sterowania.
- `update.sh --status` (JSON dla panelu) i `update.sh --no-install`.

## 0.44.3
- **Lista głośników i mikrofonów była niepełna** (zwłaszcza Windows: Chrome / Edge). Przeglądarka pokazuje wszystkie urządzenia dopiero przy zgodzie na mikrofon. Od 0.43.0 komputer otwiera mikrofon tylko na czas mówienia, a lista w ustawieniach budowała się, zanim mikrofon się otworzył – przy zgodzie „tylko tym razem” widać było jedno wyjście bez nazwy. Teraz lista odświeża się po otwarciu mikrofonu do podglądu, a gdy przeglądarka i tak zwraca okrojoną listę (np. osoba tylko słuchająca), w ustawieniach jest przycisk **🔓 Pokaż wszystkie urządzenia** (chwilowo otwiera mikrofon i od razu go zamyka). W Firefoksie dodatkowo **Wybierz inne wyjście…** (systemowe okno wyboru).

## 0.44.2
- Instalator: pierwsza instalacja w czystym folderze (np. świeżo pobranym z GitHuba) przerywała się w linii 238 – brakowało jeszcze plików konfiguracji LiveKit i Caddy, których sumę sprawdzał.

## 0.44.1 (aplikacja 1.4.1)
- **Aktualizacje z GitHuba:** `./update.sh` pobiera najnowszą (albo wskazaną) wersję i uruchamia instalator; ustawienia zostają (README → „Aktualizacje z GitHuba”).
- **Transmisja zmieniała wysokość dźwięku („pływała”).** Dwie przyczyny:
  - *Tryb ⚡ ultra (lokalny odsłuch, przeglądarka i aplikacja):* odtwarzacz wyrównuje bufor, minimalnie przyspieszając lub zwalniając. Korekta sięgała ±2–3% i zmieniała się z każdą nierówną porcją z Wi-Fi – na muzyce słychać to jako falowanie wysokości. Teraz najwyżej ±0,3% (ok. 5 centów), według średniego zapełnienia bufora i ze stopniowymi zmianami – niesłyszalnie. Duże nadwyżki dalej są przeskakiwane.
  - *Aplikacja na iPhonie (odtwarzacz stereo):* po zmianie trasy dźwięku – np. AirPods przechodzą w tryb rozmowy (16/24 kHz) przy otwarciu mikrofonu albo wracają do 48 kHz – połączenie z wyjściem zostawało na starej częstotliwości i transmisja grała za szybko lub za wolno. Teraz odtwarzacz łączy się od nowa z aktualną częstotliwością słuchawek. Wymaga przebudowy aplikacji (`npm run sync` i Xcode). Android odtwarza transmisję przez LiveKit – tam tego problemu nie było, poprawka trybu ultra działa też na Androidzie bez przebudowy.

## 0.44.0
- **Uporządkowany panel administracyjny.** Zamiast przepełnionej zakładki „Ogólne” – 9 zakładek tematycznych: **Stan** (osoby online, uprawnienia, ksywki, czat) · **Ogólne** (nazwa, wygląd, aplikacja na telefon) · **Dostęp i PIN-y** (PIN-y, dostęp spoza sieci) · **Kanały i przyciski** · **🎵 Dźwięk transmisji** · **Transkrypcja** (model, gdzie działa, osoby, słownik, ostatnie nagrania – w osobnych kartach) · **Planning Center** · **Transmisja live** (Web Presenter, YouTube, Facebook, mostek) · **Serwer** (obciążenie, restart, kopia ustawień). Na komputerze zakładki są menu po lewej, na telefonie przewijanym paskiem u góry. Długie objaśnienia schowane pod „Jak to działa”. Ustawienia i ich zapis bez zmian.

## 0.43.1
- Muzyka w innych programach nadal cichła w chwili naciśnięcia „mów”: ściszanie robi systemowa redukcja echa (macOS Voice Processing / tryb komunikacji Windows), włączana przez przeglądarkę razem z mikrofonem. Na komputerze redukcja echa jest teraz domyślnie wyłączona (⚙️ → Mikrofon → Przetwarzanie mikrofonu; włącz przy mówieniu przez głośniki). Na telefonie bez zmian.

## 0.43.0 (aplikacja 1.4.0)
- **Ściszanie tylko transmisji, nie całego komputera.** Na komputerze stale otwarty mikrofon (z redukcją echa) przełączał system w tryb rozmowy, który ściszał muzykę i filmy w innych programach. Teraz na komputerze mikrofon otwiera się tylko na czas mówienia (⚙️ → „Otwieraj mikrofon dopiero przy mówieniu”, domyślnie włączone na komputerze, wyłączone na telefonie; start mówienia ok. 0,3 s później). W ustawieniach mikrofon jest otwarty na czas podglądu poziomu.
- **Wybór mikrofonu i głośnika:** wybrane wyjście działa teraz także dla dźwięku odtwarzanego przez Web Audio (transmisja – także tryb ⚡ ultra – i sygnały); wcześniej szło ono na domyślne wyjście. Urządzenia są zapamiętywane także po nazwie (Safari i Chrome potrafią zmienić identyfikator urządzenia – wybór po cichu wracał do domyślnego).
- **Przełączanie punktów Planning Center Live:** przycisk pokazuje „⏳ Przełączam…”, a brak odpowiedzi, zajęte poprzednie przełączenie albo brak połączenia jest zgłaszany komunikatem (wcześniej kliknięcie bez efektu wyglądało jak niedziałający przycisk). Lista punktów ma jedną obsługę kliknięć odporną na przerysowanie i na zachowanie Safari.
- **Kolumny kanałów** (tablet, komputer; ⚙️ → Kolumny kanałów): 2–4 kanały obok siebie; pierwsza kolumna = kanał, na który mówisz, w pozostałych wybór kanału do podglądu, 🎙 przenosi mówienie na kanał kolumny, ✕ zamyka kolumnę.
- **Transkrypcja per osoba i per kanał:** administrator wyłącza transkrypcję wybranej osoby (👥 → osoba → 📝, albo panel → Transkrypcja → „Osoby”) i całego kanału (👥 → przy nazwie kanału, albo panel jak dotąd).
- **Moderacja:** administrator oraz osoby sterujące planem (reżyser) mogą **wyciszyć** osobę (👥 → osoba → 🔇 Wycisz; serwer wycisza też jej mikrofon w LiveKit) i **przenieść** ją na inny kanał (↪ Przenieś). Osoba dostaje powiadomienie z sygnałem – w przeglądarce i w aplikacji, także przy zablokowanym ekranie.

## 0.42.0
- **🎧 Mówienie pałąkiem słuchawek** (na razie w przeglądarce; ⚙️ → Mikrofon): słuchawki z wyciszaniem mikrofonu podniesieniem pałąka odcinają mikrofon – strona rozpoznaje to po zaniku sygnału i sama włącza mówienie po opuszczeniu pałąka, a kończy po podniesieniu (po 0,5 s, żeby pauza w mowie nie przerywała). Kalibracja „opuść / podnieś” ustawia próg dla konkretnych słuchawek; wskaźnik pokazuje położenie pałąka i poziom sygnału. Przycisk „mów” działa dalej normalnie.
- **Inne aplikacje na tym samym serwerze:** pliki `caddy/sites/*.caddy` są dołączane do konfiguracji Caddy i instalator ich nie nadpisuje (przykład w `caddy/sites/00-przyklad.caddy`). Po zmianie: `sudo docker compose restart caddy`.

## 0.41.2
- Instalator: po przeniesieniu serwera do innej sieci (nowy adres IP) ponowne `sudo ./install.sh` brało stary adres z `.env` i ustawiało DuckDNS z powrotem na niego. Teraz zawsze używa adresu wykrytego na serwerze i informuje o zmianie.

## 0.41.1 (aplikacja 1.3.4)
- Android: budowanie kończyło się błędem „Could not resolve com.github.davidliu:audioswitch” – projekt aplikacji nie szukał bibliotek w JitPack (potrzebnym LiveKit). `scripts/android-setup.sh` (uruchamiany przez `npm run android`) dopisuje teraz JitPack do `android/build.gradle`.

## 0.41.0
- **Plik aplikacji na Androida na własnym serwerze.** Panel → Ogólne → Aplikacja na telefon → *Wgraj plik APK*. Plik leży w `data/app/download/`, jest dostępny pod `/pobierz/interkom.apk`, a gdy pole z linkiem do Google Play jest puste, ekran logowania sam pokazuje przycisk „Pobierz na Androida (APK)”. Panel pokazuje datę wgrania, rozmiar i liczbę pobrań. Nowa wersja = wgranie nowego pliku (stary jest zastępowany).

## 0.40.4 (aplikacja 1.3.3)
- **Android: „🎧 Jakość muzyczna”** w okienku 🎵 (jak na iPhonie): zwykły tryb dźwięku Androida zamiast „rozmowy telefonicznej”, słuchawki Bluetooth w trybie muzycznym, wyjście stereo; mówi się wtedy przez mikrofon telefonu. Przełączenie robi szybkie ponowne połączenie (ok. 1–2 s ciszy).
- Android: sama transmisja przez serwer jest nadal mono – biblioteka LiveKit dla Androida nie zgłasza odbioru stereo i nie pozwala tego dopisać z zewnątrz. Przełącznik „Stereo” jest więc widoczny tylko na iPhonie.
- Strona w przeglądarce (także w Chrome na Androidzie): ta sama poprawka „zasypiającego” mikrofonu co w Safari.

## 0.40.3 (aplikacja 1.3.2)
- iPhone: błąd kompilacji w Xcode („unable to type-check this expression in reasonable time”) – poprawione.
- iPhone: biblioteka LiveKit zgłaszała odbiór stereo tylko dla ścieżki transmisji; iOS odrzucał taki opis połączenia („All codecs must share the same … parameters”) i dekoder wracał do mono. Aplikacja łączy się teraz jednym połączeniem WebRTC (*single peer connection*, LiveKit ≥ 1.9.2), w którym stereo jest zgłaszane dla wszystkich ścieżek naraz.

## 0.40.2 (aplikacja 1.3.1)
- iPhone: aplikacja zawieszała się przy wyłączaniu „Stereo” (i przy wyłączaniu słuchania transmisji) – zatrzymanie odtwarzacza blokowało się samo na sobie. Poprawione. Serwera nie trzeba aktualizować.

## 0.40.1 (aplikacja 1.3.0)
- **iPhone: transmisja naprawdę w stereo i w jakości z panelu.** Wbudowane odtwarzanie LiveKit/WebRTC na iPhonie zawsze miksuje dźwięk do mono i gra go „jak rozmowę telefoniczną”. Aplikacja odtwarza teraz transmisję własnym odtwarzaczem stereo (w okienku 🎵: *Stereo (zalecane)*, domyślnie włączone).
- **Nowa opcja w okienku 🎵 na iPhonie: „🎧 Jakość muzyczna”** – do słuchania w słuchawkach. Wyłącza obróbkę rozmowy iPhone'a (dźwięk przestaje brzmieć jak telefon; echo dalej usuwa WebRTC), a słuchawki Bluetooth (AirPods) grają w trybie muzycznym, w stereo – do interkomu mówi się wtedy przez mikrofon telefonu (mikrofon AirPods działa tylko w trybie rozmowy). Bez słuchawek lepiej ją zostawić wyłączoną.
- **Safari: mikrofon „zasypiał”** – po pewnym czasie (uśpienie Maca, przejście na inną kartę, blokada ekranu) przycisk „Mów” nie nadawał nic do odświeżenia strony. Strona sama sprawdza teraz mikrofon co kilka sekund i przy naciśnięciu „Mów”, a gdy przestał działać – pobiera go ponownie (bez odświeżania).
- Android: transmisja przez serwer nadal mono (ograniczenie biblioteki LiveKit dla Androida).
- Aktualizacja: serwer `sudo ./install.sh`; aplikację na iPhone trzeba przebudować (`npx cap sync ios`, potem Xcode ▶).

## 0.40.0
- **Jakość dźwięku transmisji do wyboru** (panel → Dźwięk transmisji → *Jakość dźwięku*): 96, 128, **160 (domyślnie)**, 192, 256 albo 320 kb/s, zawsze stereo (Opus). Zmiana działa od razu – bez restartu nadajnika i bez ponownego łączenia słuchaczy. Dotyczy wszystkich dróg: strony nadajnika w przeglądarce, wejścia audio serwera, lokalnego odsłuchu (także trybu ⚡ ultra) i odsłuchu przez serwer (LiveKit).
- **Stereo przez serwer z wejścia audio serwera.** Dotąd nadajnik na serwerze wysyłał do LiveKit mono (biblioteka LiveKit dla Node nie umie oznaczyć ścieżki jako stereo) – stereo było tylko w sieci lokalnej w trybie ultra. Teraz usługa `audio` ma mały program `ik-publish` (Go, budowany razem z obrazem), który przekazuje do LiveKit te same pakiety Opus co tryb ultra, oznaczone jako stereo – bez ponownego kodowania. Jeśli programu zabraknie, usługa nadaje jak dawniej (mono).
- Słuchacz nie ogranicza już jakości w lokalnym odsłuchu (wcześniej odpowiedź telefonu ustawiała limit 128 kb/s).
- Aplikacja na Androida odtwarza transmisję przez LiveKit jeszcze w mono (biblioteka LiveKit dla Androida nie negocjuje stereo); iPhone, przeglądarki i lokalny odsłuch – stereo.
- Aktualizacja: `sudo ./install.sh` (przebuduje obraz `audio` – pierwszy raz pobiera kompilator Go, ok. 2–4 min dłużej).

## 0.39.2 (aplikacja 1.2.1)

- Aplikacja nie zawiesza się już na „Łączeniu”, gdy zapamiętany serwer jest nieosiągalny, np. adres lokalny poza kościołem. Przy starcie sprawdza (do 4 s), który z zapamiętanych serwerów odpowiada, i sama wybiera pierwszy działający: najpierw ostatnio używany, potem kolejne z listy. Jeśli żaden nie odpowiada, pokazuje listę z komunikatem. Ekran łączenia ma przycisk „Anuluj – wybierz inny serwer”. Wpisany ręcznie adres, który nie odpowiada, można połączyć mimo to, dotykając go drugi raz.
- Android: po uruchomieniu aplikacja zawsze zaczyna od tego sprawdzenia, zamiast od razu otwierać zapamiętany serwer.
- Wymaga przebudowy aplikacji.
