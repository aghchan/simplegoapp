package example

import (
	"fmt"

	"go.uber.org/zap"
)

type Service interface {
	Hello()
	Bye()
}

type service struct {
	logger *zap.SugaredLogger
}

func (this service) Hello() {
	fmt.Println("hello")
}

func (this service) Bye() {
	fmt.Println("bye")
}

func NewService(
	logger *zap.SugaredLogger,
) Service {
	return &service{
		logger: logger,
	}
}
