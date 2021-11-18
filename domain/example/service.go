package example

import (
	"fmt"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

type Service interface {
	Hello()
	Bye()
}

type service struct {
	logger logger.Logger
}

func (this service) Hello() {
	fmt.Println("hello")
}

func (this service) Bye() {
	fmt.Println("bye")
}

func NewService(
	logger logger.Logger,
) Service {
	return &service{
		logger: logger,
	}
}
