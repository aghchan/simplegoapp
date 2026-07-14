package apierror

import (
	"encoding/json"
	"errors"
	"net/http"
)

type Error struct {
	Status int
	Code   string
	Detail string
}

func (this *Error) Error() string { return this.Code + ": " + this.Detail }

func Invalid(detail string) *Error { return &Error{Status: 400, Code: "invalid", Detail: detail} }
func Unauthorized(detail string) *Error {
	return &Error{Status: 401, Code: "unauthorized", Detail: detail}
}
func Forbidden(detail string) *Error { return &Error{Status: 403, Code: "forbidden", Detail: detail} }
func NotFound(detail string) *Error  { return &Error{Status: 404, Code: "not_found", Detail: detail} }
func Conflict(detail string) *Error  { return &Error{Status: 409, Code: "conflict", Detail: detail} }
func NotAcceptable(detail string) *Error {
	return &Error{Status: 406, Code: "not_acceptable", Detail: detail}
}
func UnsupportedMedia(detail string) *Error {
	return &Error{Status: 415, Code: "unsupported_media_type", Detail: detail}
}
func Timeout() *Error               { return &Error{Status: 504, Code: "timeout", Detail: "request timed out"} }
func Internal(detail string) *Error { return &Error{Status: 500, Code: "internal", Detail: detail} }
func MethodNotAllowed() *Error {
	return &Error{Status: 405, Code: "method_not_allowed", Detail: "method not allowed"}
}

type problem struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail,omitempty"`
	Code     string `json:"code"`
	Instance string `json:"instance,omitempty"`
}

// Write renders err as an RFC 9457 problem; unknown errors become a generic
// 500 so internals never reach clients.
func Write(w http.ResponseWriter, r *http.Request, err error) {
	e := &Error{}
	if !errors.As(err, &e) {
		e = &Error{Status: 500, Code: "internal", Detail: "internal server error"}
	}

	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(e.Status)
	json.NewEncoder(w).Encode(problem{
		Type:     "about:blank",
		Title:    http.StatusText(e.Status),
		Status:   e.Status,
		Detail:   e.Detail,
		Code:     e.Code,
		Instance: r.URL.Path,
	})
}
