package http

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/aghchan/simplegoapp/pkg/http/apierror"
)

type Codec interface {
	MediaType() string
	Encode(w io.Writer, v interface{}) error
	Decode(r io.Reader, v interface{}) error
}

var codecs = map[string]Codec{}

// RegisterCodec must be called at startup, before serving; the registry is
// not synchronized.
func RegisterCodec(c Codec) { codecs[c.MediaType()] = c }

type jsonCodec struct{}

func (jsonCodec) MediaType() string                       { return "application/json" }
func (jsonCodec) Encode(w io.Writer, v interface{}) error { return json.NewEncoder(w).Encode(v) }
func (jsonCodec) Decode(r io.Reader, v interface{}) error { return json.NewDecoder(r).Decode(v) }

func init() { RegisterCodec(jsonCodec{}) }

func requestCodec(r *http.Request) (Codec, error) {
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}
	if mediaType, _, err := mime.ParseMediaType(contentType); err == nil {
		contentType = mediaType
	}

	codec, ok := codecs[contentType]
	if !ok {
		return nil, apierror.UnsupportedMedia(contentType)
	}

	return codec, nil
}

// SpecErrorHandler adapts generated-router binding errors (bad path/query
// params) to problem responses; pass it as GorillaServerOptions.ErrorHandlerFunc.
func SpecErrorHandler(w http.ResponseWriter, r *http.Request, err error) {
	apierror.Write(w, r, apierror.Invalid(err.Error()))
}

func responseCodec(r *http.Request) (Codec, error) {
	accept := r.Header.Get("Accept")
	if accept == "" {
		return codecs["application/json"], nil
	}

	for _, part := range strings.Split(accept, ",") {
		mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(part))
		if err != nil {
			continue
		}
		if mediaType == "*/*" || mediaType == "application/*" {
			return codecs["application/json"], nil
		}
		if codec, ok := codecs[mediaType]; ok {
			return codec, nil
		}
	}

	return nil, apierror.NotAcceptable(accept)
}
