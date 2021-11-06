package example

import (
	"fmt"

	"go.uber.org/zap"
)

type ExampleService interface {
	Hello()
	Bye()
}

type exampleService struct {
	logger *zap.SugaredLogger
}

func (this exampleService) Hello() {
	fmt.Println("hello")
}

func (this exampleService) Bye() {
	fmt.Println("bye")
}

func NewExampleService(
	logger *zap.SugaredLogger,
) ExampleService {
	return &exampleService{
		logger: logger,
	}
}
