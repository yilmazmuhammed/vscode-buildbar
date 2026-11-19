# proje-c: klasik Makefile. Derleme secenekleri .vscode/tasks.json
# icinde birer gorev olarak tanimli; BuildBar o listeyi okur.

ARCH ?= host
OPT  ?= O0

CC_host  := cc
CC_arm   := arm-linux-gnueabihf-gcc
CC       := $(CC_$(ARCH))

OUT := build/$(ARCH)-$(OPT)

.PHONY: all clean
all: $(OUT)/parser

$(OUT)/parser: src/main.c src/parser.c | $(OUT)
	$(CC) -$(OPT) -Wall -Wextra -Iinclude -o $@ $^

$(OUT):
	mkdir -p $(OUT)

clean:
	rm -rf build
