// ik-publish – nadaje gotowe pakiety Opus (stereo) do LiveKit jako ścieżkę „stereo”.
// Biblioteka LiveKit dla Node (rtc-node) nie umie oznaczyć ścieżki jako stereo, więc odbiorcy dostawali mono.
// Ten mały program dostaje z audio.mjs (stdin) pakiety Opus zakodowane już w wybranej jakości i wysyła je
// bez ponownego kodowania. Format wejścia: [2 bajty długości, big-endian][pakiet Opus 10 ms] …
//
// Użycie: ik-publish <url-livekit> <token>
package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

func say(format string, a ...any) { fmt.Fprintf(os.Stdout, format+"\n", a...) }

func main() {
	if len(os.Args) < 3 {
		say("ERR użycie: ik-publish <url> <token>")
		os.Exit(2)
	}
	url, token := os.Args[1], os.Args[2]

	done := make(chan struct{})
	var once sync.Once
	room, err := lksdk.ConnectToRoomWithToken(url, token, &lksdk.RoomCallback{
		OnDisconnected: func() { once.Do(func() { say("DISCONNECTED"); close(done) }) },
	}, lksdk.WithAutoSubscribe(false))
	if err != nil {
		say("ERR połączenie: %v", err)
		os.Exit(1)
	}

	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeOpus,
		ClockRate:   48000,
		Channels:    2,
		SDPFmtpLine: "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1",
	}, "audio", "ik-program")
	if err != nil {
		say("ERR ścieżka: %v", err)
		os.Exit(1)
	}
	if _, err = room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:       "program",
		Source:     livekit.TrackSource_MICROPHONE,
		Stereo:     true,
		DisableDTX: true,
	}); err != nil {
		say("ERR publikacja: %v", err)
		room.Disconnect()
		os.Exit(1)
	}
	say("OK nadaje stereo")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		select {
		case <-sig:
		case <-done:
		}
		room.Disconnect()
		os.Exit(0)
	}()

	in := bufio.NewReaderSize(os.Stdin, 64*1024)
	hdr := make([]byte, 2)
	buf := make([]byte, 4096)
	errs := 0
	for {
		if _, err := io.ReadFull(in, hdr); err != nil {
			break
		}
		n := int(binary.BigEndian.Uint16(hdr))
		if n == 0 || n > len(buf) {
			say("ERR zły pakiet: %d", n)
			break
		}
		if _, err := io.ReadFull(in, buf[:n]); err != nil {
			break
		}
		pkt := make([]byte, n)
		copy(pkt, buf[:n])
		if err := track.WriteSample(media.Sample{Data: pkt, Duration: 10 * time.Millisecond}); err != nil {
			if errs++; errs <= 3 || errs%6000 == 0 {
				say("WARN zapis (%d): %v", errs, err)
			}
		}
	}
	room.Disconnect()
}
