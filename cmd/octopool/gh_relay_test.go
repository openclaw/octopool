package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"testing"
)

func TestDecodeRelayBody(t *testing.T) {
	tests := []struct {
		name     string
		envelope relayEnvelope
		want     []byte
		wantErr  bool
	}{
		{name: "json", envelope: relayEnvelope{BodyEncoding: "json", Body: []byte(`{"ok":true}`)}, want: []byte(`{"ok":true}`)},
		{name: "text", envelope: relayEnvelope{BodyEncoding: "text", Body: []byte(`"hello"`)}, want: []byte("hello")},
		{name: "null text", envelope: relayEnvelope{BodyEncoding: "text", Body: []byte("null")}},
		{name: "base64", envelope: relayEnvelope{BodyEncoding: "base64", Body: quotedBase64([]byte{0, 1, 2})}, want: []byte{0, 1, 2}},
		{name: "unknown", envelope: relayEnvelope{BodyEncoding: "yaml", Body: []byte(`"unsafe"`)}, wantErr: true},
		{name: "missing", envelope: relayEnvelope{Body: []byte(`{"unsafe":true}`)}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := decodeRelayBody(test.envelope)
			if (err != nil) != test.wantErr {
				t.Fatalf("decodeRelayBody() error = %v, wantErr %v", err, test.wantErr)
			}
			if !bytes.Equal(got, test.want) {
				t.Fatalf("decodeRelayBody() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestEnvelopeBodyBytesRejectsGitHubErrorStatus(t *testing.T) {
	_, err := envelopeBodyBytes(relayEnvelope{
		Status:       404,
		BodyEncoding: "json",
		Body:         []byte(`{"message":"Not Found"}`),
	})
	if err == nil {
		t.Fatal("expected GitHub status error")
	}
}

func TestRawRelayOutputWriteErrors(t *testing.T) {
	envelope := relayEnvelope{Status: 200, BodyEncoding: "text", Body: []byte(`"hello"`)}
	wantError := errors.New("output closed")
	for _, test := range []struct {
		name string
		out  relayBodyTestWriter
		want error
	}{
		{"write error", relayBodyTestWriter{err: wantError}, wantError},
		{"short write", relayBodyTestWriter{n: 1}, io.ErrShortWrite},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := writeGHBody(t.Context(), test.out, envelope, ""); !errors.Is(err, test.want) {
				t.Errorf("direct output error = %v, want %v", err, test.want)
			}
			if err := writeGHAPIPages(t.Context(), test.out, []relayEnvelope{envelope}, "", false); !errors.Is(err, test.want) {
				t.Errorf("paginated output error = %v, want %v", err, test.want)
			}
		})
	}
}

type relayBodyTestWriter struct {
	n   int
	err error
}

func (w relayBodyTestWriter) Write([]byte) (int, error) { return w.n, w.err }

func quotedBase64(value []byte) []byte {
	return []byte(`"` + base64.StdEncoding.EncodeToString(value) + `"`)
}
