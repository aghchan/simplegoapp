package app

import (
	"github.com/gorilla/mux"
)

type Router struct {
	// ("/sample", controller)
	*mux.Router

	//	controllerByPath map[string]string
}

type HttpVerb string

const (
	HttpVerb_Get    = "GET"
	HttpVerb_Post   = "POST"
	HttpVerb_Put    = "PUT"
	HttpVerb_Delete = "DELETE"
)

var httpVerbs = map[string]bool{
	HttpVerb_Get:    true,
	HttpVerb_Post:   true,
	HttpVerb_Put:    true,
	HttpVerb_Delete: true,
}
