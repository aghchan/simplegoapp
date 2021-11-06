package main

import (
	"simplegoapp/app"
	controller "simplegoapp/app/controller/example"
	"simplegoapp/domain/example"
	"simplegoapp/domain/example2"
)

func main() {
	routes := []interface{}{
		"/hello", &controller.ExampleController{},
	}

	app := app.NewApp(
		"localhost",
		8080,
		routes,
		example.NewExampleService,
		example2.NewExample2Service,
	)

	app.Run()
}
